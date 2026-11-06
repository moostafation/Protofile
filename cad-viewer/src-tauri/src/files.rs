//! Opening, saving and printing files for the page.
//!
//! The page never names a path to write to, and can only read files the user chose:
//! in the Open dialog, on the command line (double-click in Explorer, "Open with"),
//! by dropping them on the window, or earlier (recent files).

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::recent;

/// Files the user chose in this session, files waiting for the page to open them, and whether
/// the open drawing has unsaved changes (closing the window then asks the page first).
#[derive(Default)]
pub struct Session {
    allowed: Mutex<HashSet<PathBuf>>,
    pending: Mutex<Vec<PathBuf>>,
    /// Why handed-over files could not be opened (collected with the pending files).
    errors: Mutex<Vec<String>>,
    modified: AtomicBool,
    /// Folder of the last Save dialog (also kept in the app data folder between runs).
    last_dir: Mutex<Option<PathBuf>>,
}

impl Session {
    pub fn allow(&self, path: &Path) {
        lock(&self.allowed).insert(path.to_path_buf());
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        lock(&self.allowed).contains(path)
    }

    pub fn is_modified(&self) -> bool {
        self.modified.load(Ordering::SeqCst)
    }
}

/// The page reports unsaved changes, so closing the window asks before the drawing is lost.
#[tauri::command]
pub fn set_modified(session: State<'_, Session>, modified: bool) {
    session.modified.store(modified, Ordering::SeqCst);
}

/// Closes the window once the page has asked about unsaved changes.
#[tauri::command]
pub fn close_window(window: WebviewWindow, session: State<'_, Session>) -> Result<(), String> {
    session.modified.store(false, Ordering::SeqCst);
    window.destroy().map_err(|e| e.to_string())
}

/// Window close or File > Quit: with unsaved changes the page asks Save / Don't save / Cancel
/// (it then calls `close_window`); returns true when the close must wait for that.
pub fn ask_before_closing(app: &AppHandle) -> bool {
    if !app.state::<Session>().is_modified() {
        return false;
    }
    let _ = app.emit("close-requested", ());
    true
}

/// Locks a mutex, recovering the data if a previous holder panicked.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Queues files to open (command line, second launch, drag & drop, Open Recent) and tells
/// the page, which collects them with `take_pending`, so none is lost before it is ready.
pub fn queue_open(app: &AppHandle, paths: Vec<PathBuf>) {
    // The page works with paths as text: names that are not valid Unicode (possible on Linux),
    // or that came through a lossy conversion, cannot be opened; say so instead of "not found".
    let (paths, bad): (Vec<PathBuf>, Vec<PathBuf>) =
        paths.into_iter().partition(|p| p.to_str().is_some_and(|s| !s.contains('\u{FFFD}') || p.exists()));
    let session = app.state::<Session>();
    for path in &bad {
        lock(&session.errors).push(format!(
            "{} cannot be opened: its name contains characters that are not valid Unicode. Rename the file and open it again.",
            path.to_string_lossy()
        ));
    }
    if paths.is_empty() {
        if !bad.is_empty() {
            let _ = app.emit("open-pending", ());
        }
        return;
    }
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
/// Takes `OsString`s (`std::env::args_os`), so names that are not valid Unicode do not panic.
pub fn paths_from_args<S: Into<OsString>>(args: impl IntoIterator<Item = S>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .map(Into::into)
        .filter(|arg: &OsString| !arg.is_empty() && !arg.to_string_lossy().starts_with('-'))
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
        let extensions = filter_extensions(&filter.extensions);
        let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    dialog
}

/// GTK file filters are case-sensitive: also list the upper-case extensions there (E.PLT, PLAN.DWG).
fn filter_extensions(extensions: &[String]) -> Vec<String> {
    let mut out: Vec<String> = extensions.to_vec();
    if cfg!(target_os = "linux") {
        for ext in extensions {
            let upper = ext.to_uppercase();
            if upper != *ext && !out.contains(&upper) {
                out.push(upper);
            }
        }
    }
    out
}

/// A file name that is safe on every platform: no `\ / : * ? " < > |` or control characters,
/// no trailing dots or spaces, not a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9,
/// LPT1-9, also with an extension), at most 150 characters; `fallback` when nothing is left.
pub fn safe_file_name(name: &str, fallback: &str) -> String {
    let mut clean: String = name
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .take(150)
        .collect();
    clean = clean.trim().trim_end_matches(['.', ' ']).to_string();
    if clean.is_empty() || clean.chars().all(|c| c == '.') {
        clean = fallback.to_string();
    }
    let stem = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        clean.insert(0, '_');
    }
    clean
}

/// Adds the filter's extension to a name typed without one (or with another): "plan" -> "plan.pdf".
fn with_extension(path: PathBuf, filters: &[Filter]) -> PathBuf {
    let wanted: Vec<&str> = filters.iter().flat_map(|f| f.extensions.iter().map(String::as_str)).filter(|e| *e != "*").collect();
    let Some(first) = wanted.first() else { return path };
    let has = path.extension().and_then(|e| e.to_str()).is_some_and(|e| wanted.iter().any(|w| w.eq_ignore_ascii_case(e)));
    if has {
        return path;
    }
    let mut name = path.as_os_str().to_owned();
    name.push(".");
    name.push(first);
    PathBuf::from(name)
}

const LAST_DIR_FILE: &str = "last-save-folder.txt";

/// Folder the Save dialog starts in: the open drawing's folder when the page knows it, otherwise
/// the folder of the last save (this run, or an earlier one).
fn save_folder(app: &AppHandle, session: &Session, page_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = page_dir.filter(|d| d.is_dir()) {
        return Some(dir);
    }
    let mut last = lock(&session.last_dir);
    if last.is_none() {
        let file = app.path().app_data_dir().ok()?.join(LAST_DIR_FILE);
        *last = std::fs::read_to_string(file).ok().map(|s| PathBuf::from(s.trim()));
    }
    last.clone().filter(|d| d.is_dir())
}

fn remember_folder(app: &AppHandle, session: &Session, path: &Path) {
    let Some(dir) = path.parent() else { return };
    *lock(&session.last_dir) = Some(dir.to_path_buf());
    if let (Ok(data), Some(text)) = (app.path().app_data_dir(), dir.to_str()) {
        let _ = std::fs::create_dir_all(&data);
        let _ = std::fs::write(data.join(LAST_DIR_FILE), text);
    }
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

/// File types a 3D model may load from its own folder: an OBJ's MTL and textures, a glTF's
/// buffers and images.
const SIBLING_TYPES: &[&str] = &["mtl", "bin", "png", "jpg", "jpeg", "gif", "bmp", "webp", "tga", "tif", "tiff"];

/// The file `name` next to `base`, when `name` is a plain file name of a resource type: no folder
/// parts, no `..`, no drive or stream (`:`). Matches the name case-insensitively when the exact
/// spelling is not there (models made on Windows refer to "Texture.JPG" for "texture.jpg").
fn sibling_path(base: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err(format!("{name} is not a file name."));
    }
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !SIBLING_TYPES.contains(&ext.as_str()) {
        return Err(format!("{name} is not a material, buffer or texture file."));
    }
    let dir = base.parent().ok_or_else(|| format!("{} has no folder.", base.display()))?;
    let exact = dir.join(name);
    if exact.is_file() {
        return Ok(exact);
    }
    let lower = name.to_lowercase();
    std::fs::read_dir(dir)
        .ok()
        .and_then(|entries| {
            entries.filter_map(Result::ok).map(|e| e.path()).find(|p| p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.to_lowercase() == lower))
        })
        .ok_or_else(|| format!("{name} was not found next to {}.", file_name(base)))
}

/// Reads a file next to a file the user opened (see `sibling_path`), so a 3D model made of
/// several files (OBJ + MTL + textures, glTF + .bin) opens from Explorer with its materials.
#[tauri::command]
pub async fn read_sibling(app: AppHandle, path: String, name: String) -> Result<Response, String> {
    let base = PathBuf::from(path);
    if !app.state::<Session>().is_allowed(&base) && !recent::contains(&app, &base) {
        return Err(format!("{} was not opened by you.", file_name(&base)));
    }
    let file = sibling_path(&base, &name)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(file)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Files waiting to be opened (see `queue_open`), and messages about files that cannot be.
#[derive(Serialize)]
pub struct Pending {
    paths: Vec<String>,
    errors: Vec<String>,
}

/// Collected by the page when it starts and on `open-pending`, so nothing queued before the
/// page was ready (command line, second launch) is lost.
#[tauri::command]
pub fn take_pending(session: State<'_, Session>) -> Pending {
    Pending {
        paths: lock(&session.pending).drain(..).filter_map(|p| path_string(&p).ok()).collect(),
        errors: lock(&session.errors).drain(..).collect(),
    }
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
/// Headers (percent-encoded): `x-file-name` (suggested name), `x-filters` (JSON list of filters),
/// optional `x-directory` (the open drawing's folder). A name typed without the filter's
/// extension gets it. Resolves to the saved path, or null when cancelled.
#[tauri::command]
pub async fn save_file(app: AppHandle, window: WebviewWindow, session: State<'_, Session>, request: Request<'_>) -> Result<Option<String>, String> {
    let bytes = body(&request)?;
    let name = safe_file_name(&header(&request, "x-file-name")?, "drawing");
    let filters: Vec<Filter> = serde_json::from_str(&header(&request, "x-filters")?).map_err(|e| e.to_string())?;
    let page_dir = header(&request, "x-directory").ok().filter(|d| !d.is_empty()).map(PathBuf::from);
    let mut dialog = with_filters(window.dialog().file().set_parent(&window).set_file_name(name), &filters);
    if let Some(dir) = save_folder(&app, &session, page_dir) {
        dialog = dialog.set_directory(dir);
    }
    let Some(chosen) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = with_extension(chosen.into_path().map_err(|e| e.to_string())?, &filters);
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    remember_folder(&app, &session, &path);
    // A drawing saved here can be saved again (Ctrl+S) without the dialog.
    session.allow(&path);
    path_string(&path).map(Some)
}

/// Saves a drawing back to its file (Ctrl+S): only DXF files the user opened or saved, written
/// through a temporary file so a failed write never leaves half a drawing.
/// Headers: `x-path` (percent-encoded). Body: the file contents.
#[tauri::command]
pub async fn write_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let bytes = body(&request)?;
    let path = PathBuf::from(header(&request, "x-path")?);
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dxf")) {
        return Err(format!("{} is not a DXF file; use Save As.", file_name(&path)));
    }
    if !app.state::<Session>().is_allowed(&path) && !recent::contains(&app, &path) {
        return Err(format!("{} was not opened by you, so it cannot be overwritten. Use Save As.", file_name(&path)));
    }
    write_replacing(&path, bytes).map_err(|e| format!("Could not save {}: {e}", path.display()))
}

fn write_replacing(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".protocad-tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// A file name that is safe on every platform, ending in `.pdf`.
fn safe_pdf_name(name: &str) -> String {
    let stem = name.strip_suffix(".pdf").or_else(|| name.strip_suffix(".PDF")).unwrap_or(name);
    format!("{}.pdf", safe_file_name(stem, "drawing"))
}

/// Writes `bytes` to a new file in `dir` named `name`, or `name (2)`, `name (3)`… when it
/// exists (a PDF app may still hold an earlier copy). Existing files are never overwritten
/// or followed (symbolic links), so other users and processes cannot redirect the write.
fn write_new_file(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let (stem, ext) = name.rsplit_once('.').map_or((name, ""), |(s, e)| (s, e));
    let mut last = None;
    for n in 1..=50 {
        let file = match (n, ext) {
            (1, _) => name.to_string(),
            (_, "") => format!("{stem} ({n})"),
            _ => format!("{stem} ({n}).{ext}"),
        };
        let path = dir.join(file);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => return f.write_all(bytes).map(|()| path),
            Err(err) => last = Some(err),
        }
    }
    Err(last.unwrap_or_else(|| ErrorKind::AlreadyExists.into()))
}

/// Prints a PDF by handing it to the system's PDF app (Edge, Acrobat, Evince…), whose
/// print dialog offers all printers, paper sizes and "actual size" scaling.
/// The PDF goes to a `print` folder in the user's own app cache folder (not the shared temp
/// folder); files older than a day are removed.
#[tauri::command]
pub async fn print_pdf(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let bytes = body(&request)?;
    let name = safe_pdf_name(&header(&request, "x-file-name")?);
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("print");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    remove_old_files(&dir, Duration::from_secs(24 * 3600));
    let path = write_new_file(&dir, &name, bytes).map_err(|e| format!("Could not write the PDF to {}: {e}", dir.display()))?;
    app.opener().open_path(path_string(&path)?, None::<&str>).map_err(|err| {
        eprintln!("Could not open {}: {err}", path.display());
        "No app for PDF files was found to print with. Save the PDF and print it from a PDF reader.".to_string()
    })
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
        let args: Vec<String> = vec!["app".into(), "--flag".into(), "a.dwg".into(), "/abs/b.pdf".into(), String::new()];
        assert_eq!(paths_from_args(args, cwd), vec![PathBuf::from("/work/a.dwg"), PathBuf::from("/abs/b.pdf")]);
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_arguments_do_not_panic() {
        use std::os::unix::ffi::OsStringExt;
        let bad = OsString::from_vec(b"/tmp/plan\xff.dwg".to_vec());
        let paths = paths_from_args(vec![OsString::from("app"), bad.clone()], Path::new("/"));
        assert_eq!(paths, vec![PathBuf::from(bad)]);
        assert!(paths[0].to_str().is_none());
    }

    #[test]
    fn file_names_are_made_safe() {
        assert_eq!(safe_file_name("plant - Layout: A/B", "x"), "plant - Layout_ A_B");
        assert_eq!(safe_file_name("CON", "x"), "_CON");
        assert_eq!(safe_file_name("nul.pdf", "x"), "_nul.pdf");
        assert_eq!(safe_file_name("COM1.csv", "x"), "_COM1.csv");
        assert_eq!(safe_file_name("COMPANY.pdf", "x"), "COMPANY.pdf");
        assert_eq!(safe_file_name("LPT", "x"), "LPT");
        assert_eq!(safe_file_name(" ... ", "drawing"), "drawing");
        assert_eq!(safe_file_name("مخطط.dxf", "x"), "مخطط.dxf");
    }

    #[test]
    fn typed_names_get_the_filter_extension() {
        let filters = vec![Filter { name: "PDF".into(), extensions: vec!["pdf".into()] }];
        assert_eq!(with_extension(PathBuf::from("/d/noext"), &filters), PathBuf::from("/d/noext.pdf"));
        assert_eq!(with_extension(PathBuf::from("/d/plan.PDF"), &filters), PathBuf::from("/d/plan.PDF"));
        assert_eq!(with_extension(PathBuf::from("/d/plan.v2"), &filters), PathBuf::from("/d/plan.v2.pdf"));
        let any = vec![Filter { name: "All".into(), extensions: vec!["*".into()] }];
        assert_eq!(with_extension(PathBuf::from("/d/x"), &any), PathBuf::from("/d/x"));
    }

    #[test]
    fn print_files_are_new_files() {
        let dir = std::env::temp_dir().join(format!("protocad-print-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = write_new_file(&dir, "plan.pdf", b"1").unwrap();
        let b = write_new_file(&dir, "plan.pdf", b"2").unwrap();
        assert_eq!(a.file_name().unwrap(), "plan.pdf");
        assert_eq!(b.file_name().unwrap(), "plan (2).pdf");
        assert_eq!(std::fs::read(&a).unwrap(), b"1");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_filters_also_match_upper_case() {
        assert_eq!(filter_extensions(&["dwg".into(), "plt".into()]), vec!["dwg", "plt", "DWG", "PLT"]);
    }

    #[test]
    fn replacing_write_keeps_no_temporary_file() {
        let dir = std::env::temp_dir().join(format!("protocad-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.dxf");
        std::fs::write(&path, b"old").unwrap();
        write_replacing(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn siblings_are_plain_resource_names_in_the_same_folder() {
        let dir = std::env::temp_dir().join(format!("protocad-sibling-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let model = dir.join("pump.obj");
        std::fs::write(&model, b"o pump").unwrap();
        std::fs::write(dir.join("pump.mtl"), b"newmtl a").unwrap();
        std::fs::write(dir.join("Steel.JPG"), b"jpg").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        assert_eq!(sibling_path(&model, "pump.mtl").unwrap(), dir.join("pump.mtl"));
        assert_eq!(sibling_path(&model, "steel.jpg").unwrap(), dir.join("Steel.JPG"));
        assert!(sibling_path(&model, "notes.txt").is_err(), "only resource types");
        assert!(sibling_path(&model, "../pump.mtl").is_err(), "no folders");
        assert!(sibling_path(&model, "sub\\pump.mtl").is_err());
        assert!(sibling_path(&model, "C:pump.mtl").is_err());
        assert!(sibling_path(&model, "missing.png").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pdf_names_are_sanitized() {
        assert_eq!(safe_pdf_name("plant: A/B.pdf"), "plant_ A_B.pdf");
        assert_eq!(safe_pdf_name("  ..  "), "drawing.pdf");
        assert_eq!(safe_pdf_name("مخطط"), "مخطط.pdf");
    }
}
