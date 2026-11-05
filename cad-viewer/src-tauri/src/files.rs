//! Opening, saving and printing files for the page.
//!
//! The page never names a path to write to, and can only read files the user chose:
//! in the Open dialog, on the command line (double-click in Explorer, "Open with"),
//! by dropping them on the window, or earlier (recent files).

use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use percent_encoding::percent_decode_str;
use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::recent;

/// Files the user chose in this session, and files waiting for the page to open them.
#[derive(Default)]
pub struct Session {
    allowed: Mutex<HashSet<PathBuf>>,
    pending: Mutex<Vec<PathBuf>>,
}

impl Session {
    pub fn allow(&self, path: &Path) {
        lock(&self.allowed).insert(path.to_path_buf());
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        lock(&self.allowed).contains(path)
    }
}

/// Locks a mutex, recovering the data if a previous holder panicked.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Queues files to open (command line, second launch, drag & drop, Open Recent) and tells
/// the page, which collects them with `take_pending`, so none is lost before it is ready.
pub fn queue_open(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let session = app.state::<Session>();
    {
        let mut pending = lock(&session.pending);
        for path in paths {
            session.allow(&path);
            pending.push(path);
        }
    }
    let _ = app.emit("open-pending", ());
}

/// File paths from a command line (the first argument is the program), relative to `cwd`.
pub fn paths_from_args(args: Vec<String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
        .map(|arg| {
            let path = PathBuf::from(arg);
            if path.is_absolute() { path } else { cwd.join(path) }
        })
        .collect()
}

pub fn on_drag_drop(app: &AppHandle, event: &DragDropEvent) {
    match event {
        DragDropEvent::Enter { .. } => {
            let _ = app.emit("drag", true);
        }
        DragDropEvent::Drop { paths, .. } => {
            let _ = app.emit("drag", false);
            queue_open(app, paths.iter().filter(|p| p.is_file()).cloned().collect());
        }
        DragDropEvent::Leave => {
            let _ = app.emit("drag", false);
        }
        _ => {}
    }
}

/// A file type filter for the native dialogs, e.g. `{ name: "PDF document", extensions: ["pdf"] }`.
#[derive(Deserialize)]
pub struct Filter {
    name: String,
    extensions: Vec<String>,
}

fn with_filters<R: tauri::Runtime>(
    mut dialog: tauri_plugin_dialog::FileDialogBuilder<R>,
    filters: &[Filter],
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    for filter in filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    dialog
}

pub fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("The file name {} is not supported.", path.display()))
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned())
}

/// Shows the native Open dialog. Resolves to the chosen path, or null when cancelled.
#[tauri::command]
pub async fn pick_file(
    window: WebviewWindow,
    session: State<'_, Session>,
    filters: Vec<Filter>,
) -> Result<Option<String>, String> {
    let dialog = with_filters(window.dialog().file().set_parent(&window), &filters);
    let Some(chosen) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    session.allow(&path);
    path_string(&path).map(Some)
}

/// Reads a file the user chose. The bytes arrive in the page as an ArrayBuffer.
#[tauri::command]
pub async fn read_file(app: AppHandle, path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    if !app.state::<Session>().is_allowed(&path) && !recent::contains(&app, &path) {
        return Err(format!("{} was not opened by you, so it cannot be read.", file_name(&path)));
    }
    if path.is_dir() {
        return Err(format!("{} is a folder. Open a file instead.", file_name(&path)));
    }
    let read = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || std::fs::read(path))
            .await
            .map_err(|e| e.to_string())?
    };
    match read {
        Ok(bytes) => Ok(Response::new(bytes)),
        Err(err) if err.kind() == ErrorKind::NotFound => {
            recent::remove(&app, &path);
            Err(format!("{} was not found. It may have been moved, renamed or deleted.", path.display()))
        }
        Err(err) => Err(format!("{}: {err}", path.display())),
    }
}

/// Paths waiting to be opened (see `queue_open`).
#[tauri::command]
pub fn take_pending(session: State<'_, Session>) -> Vec<String> {
    lock(&session.pending).drain(..).filter_map(|p| path_string(&p).ok()).collect()
}

/// A percent-encoded request header (file names may contain any character).
fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let value = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("Missing {name}"))?;
    percent_decode_str(value)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|e| e.to_string())
}

fn body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err("Expected the file contents.".into()),
    }
}

/// Asks where to save (native Save dialog) and writes the bytes sent as the request body.
/// Headers: `x-file-name` (suggested name) and `x-filters` (JSON list of filters), percent-encoded.
/// Resolves to the saved path, or null when cancelled.
#[tauri::command]
pub async fn save_file(window: WebviewWindow, request: Request<'_>) -> Result<Option<String>, String> {
    let bytes = body(&request)?;
    let name = header(&request, "x-file-name")?;
    let filters: Vec<Filter> = serde_json::from_str(&header(&request, "x-filters")?).map_err(|e| e.to_string())?;
    let dialog = with_filters(window.dialog().file().set_parent(&window).set_file_name(name), &filters);
    let Some(chosen) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    path_string(&path).map(Some)
}

/// A file name that is safe on every platform, ending in `.pdf`.
fn safe_pdf_name(name: &str) -> String {
    let stem = name.strip_suffix(".pdf").or_else(|| name.strip_suffix(".PDF")).unwrap_or(name);
    let mut clean: String = stem
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .take(100)
        .collect();
    clean = clean.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if clean.is_empty() {
        clean = "drawing".into();
    }
    format!("{clean}.pdf")
}

/// Prints a PDF by handing it to the system's PDF app (Edge, Acrobat, Evince…), whose
/// print dialog offers all printers, paper sizes and "actual size" scaling.
/// The PDF is written to a ProtoCAD folder in the temp directory; files older than a day are removed.
#[tauri::command]
pub async fn print_pdf(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let bytes = body(&request)?;
    let name = safe_pdf_name(&header(&request, "x-file-name")?);
    let dir = std::env::temp_dir().join("ProtoCAD Viewer");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    remove_old_files(&dir, Duration::from_secs(24 * 3600));
    // A PDF app may still have an earlier copy open (and locked), so try numbered names too.
    let mut last_err = None;
    for n in 1..=20 {
        let path = if n == 1 { dir.join(&name) } else { dir.join(format!("{} ({n}).pdf", name.trim_end_matches(".pdf"))) };
        match std::fs::write(&path, bytes) {
            Ok(()) => {
                return app.opener().open_path(path_string(&path)?, None::<&str>).map_err(|err| {
                    eprintln!("Could not open {}: {err}", path.display());
                    "No app for PDF files was found to print with. Save the PDF and print it from a PDF reader.".to_string()
                });
            }
            Err(err) => last_err = Some(err),
        }
    }
    Err(format!("Could not write the PDF to {}: {}", dir.display(), last_err.map_or_else(String::new, |e| e.to_string())))
}

fn remove_old_files(dir: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).is_ok_and(|d| d > age));
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn args_skip_program_and_flags_and_resolve_relative_paths() {
        let cwd = Path::new("/work");
        let args = vec!["app".into(), "--flag".into(), "a.dwg".into(), "/abs/b.pdf".into(), String::new()];
        assert_eq!(paths_from_args(args, cwd), vec![PathBuf::from("/work/a.dwg"), PathBuf::from("/abs/b.pdf")]);
    }

    #[test]
    fn pdf_names_are_sanitized() {
        assert_eq!(safe_pdf_name("plant: A/B.pdf"), "plant_ A_B.pdf");
        assert_eq!(safe_pdf_name("  ..  "), "drawing.pdf");
        assert_eq!(safe_pdf_name("مخطط"), "مخطط.pdf");
    }
}
