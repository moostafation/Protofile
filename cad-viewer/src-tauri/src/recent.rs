//! Recently opened files: kept in the app data folder, shown in File > Open Recent and on the
//! welcome screen. Files that cannot be reached when the list is read (a disconnected network
//! drive, an unplugged disk) are hidden from the welcome screen but kept; an entry is removed
//! when opening it finds the file gone, or with Clear Recent Files.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::menu::{MenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use crate::files::{lock, path_string, Session};

const MAX_RECENT: usize = 10;
const FILE_NAME: &str = "recent-files.json";

pub struct Recent {
    file: Option<PathBuf>,
    list: Mutex<Vec<PathBuf>>,
    menu: Mutex<Option<Submenu<Wry>>>,
}

impl Recent {
    pub fn load(app: &AppHandle) -> Self {
        let file = app.path().app_data_dir().ok().map(|dir| dir.join(FILE_NAME));
        let list = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from)
            .take(MAX_RECENT)
            .collect();
        Self { file, list: Mutex::new(list), menu: Mutex::new(None) }
    }

    pub fn set_menu(&self, menu: Submenu<Wry>) {
        *lock(&self.menu) = Some(menu);
    }

    fn save(&self, list: &[PathBuf]) {
        let Some(file) = &self.file else { return };
        let paths: Vec<&str> = list.iter().filter_map(|p| p.to_str()).collect();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&paths) {
            let _ = std::fs::write(file, json);
        }
    }
}

pub fn list(app: &AppHandle) -> Vec<PathBuf> {
    lock(&app.state::<Recent>().list).clone()
}

pub fn contains(app: &AppHandle, path: &Path) -> bool {
    lock(&app.state::<Recent>().list).iter().any(|p| p == path)
}

/// Changes the list, then saves it, rebuilds the Open Recent menu and tells the page.
fn update(app: &AppHandle, change: impl FnOnce(&mut Vec<PathBuf>)) {
    let recent = app.state::<Recent>();
    let list = {
        let mut list = lock(&recent.list);
        change(&mut list);
        list.truncate(MAX_RECENT);
        list.clone()
    };
    recent.save(&list);
    if let Err(err) = fill_menu(app, &list) {
        eprintln!("Could not update the Open Recent menu: {err}");
    }
    let _ = app.emit("recent-changed", to_strings(&list));
}

pub fn remove(app: &AppHandle, path: &Path) {
    if contains(app, path) {
        update(app, |list| list.retain(|p| p != path));
    }
}

fn to_strings(list: &[PathBuf]) -> Vec<String> {
    list.iter().filter_map(|p| path_string(p).ok()).collect()
}

const LABEL_MAX: usize = 70;

/// Shortens text to `max` characters by cutting out its middle: "C:\Projects\…\Pumps".
fn middle_ellipsis(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max || max < 5 {
        return text.to_string();
    }
    let keep = max - 1;
    let head = keep / 2;
    let tail = keep - head;
    let mut out: String = chars[..head].iter().collect();
    out.push('\u{2026}');
    out.extend(&chars[chars.len() - tail..]);
    out
}

/// Menu label: "name — folder", each part isolated for the bidirectional algorithm (FSI … PDI)
/// and the whole label left-to-right (LRM first), so an Arabic name still comes first; shortened
/// in the middle to about 70 characters.
/// `&` would be read as a mnemonic marker.
fn label(path: &Path) -> String {
    let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let dir = path.parent().map_or_else(String::new, |d| d.display().to_string());
    let name = middle_ellipsis(&name, LABEL_MAX / 2 + 10);
    let room = LABEL_MAX.saturating_sub(name.chars().count() + 3).max(12);
    let dir = middle_ellipsis(&dir, room);
    format!("\u{200E}\u{2068}{name}\u{2069} \u{2014} \u{2068}{dir}\u{2069}").replace('&', "&&")
}

/// Rebuilds the items of File > Open Recent (`recent:<index>`, then "Clear Recent Files").
pub fn fill_menu(app: &AppHandle, list: &[PathBuf]) -> tauri::Result<()> {
    // Cloned out of the lock: menu calls run on the main thread, which may be waiting for it.
    let Some(menu) = lock(&app.state::<Recent>().menu).clone() else { return Ok(()) };
    for item in menu.items()? {
        menu.remove(&item)?;
    }
    if list.is_empty() {
        menu.append(&MenuItem::with_id(app, "recent-none", "No recent files", false, None::<&str>)?)?;
        return Ok(());
    }
    for (i, path) in list.iter().enumerate() {
        menu.append(&MenuItem::with_id(app, format!("recent:{i}"), label(path), true, None::<&str>)?)?;
    }
    menu.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "recent-clear", "Clear Recent Files", true, None::<&str>)?)?;
    Ok(())
}

/// Opens entry `index` of the list (File > Open Recent).
pub fn open_entry(app: &AppHandle, index: usize) {
    let path = lock(&app.state::<Recent>().list).get(index).cloned();
    if let Some(path) = path {
        crate::files::queue_open(app, vec![path]);
    }
}

pub fn clear(app: &AppHandle) {
    update(app, Vec::clear);
}

/// The files of the list that can be reached now. The check runs on a copy, outside the lock
/// and off the async runtime: a disconnected network drive can take many seconds to answer,
/// and the menu (main thread) must never wait for it. Unreachable entries stay in the list.
#[tauri::command]
pub async fn recent_files(app: AppHandle) -> Vec<String> {
    let list = lock(&app.state::<Recent>().list).clone();
    let reachable = tauri::async_runtime::spawn_blocking(move || list.into_iter().filter(|p| p.is_file()).collect::<Vec<_>>())
        .await
        .unwrap_or_default();
    to_strings(&reachable)
}

/// Records a file the page opened successfully. Only files the user chose can be added.
#[tauri::command]
pub async fn add_recent(app: AppHandle, session: State<'_, Session>, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !session.is_allowed(&path) && !contains(&app, &path) {
        return Err("Only files you opened can be added to the recent files.".into());
    }
    update(&app, |list| {
        list.retain(|p| p != &path);
        list.insert(0, path);
    });
    Ok(())
}

#[tauri::command]
pub async fn clear_recent(app: AppHandle) {
    clear(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_paths_are_shortened_in_the_middle() {
        let s = middle_ellipsis("abcdefghijklmnopqrstuvwxyz", 11);
        assert_eq!(s, "abcde\u{2026}vwxyz");
        assert_eq!(s.chars().count(), 11);
        assert_eq!(middle_ellipsis("short", 70), "short");
    }

    #[cfg(unix)]
    #[test]
    fn labels_isolate_name_and_folder() {
        let deep = format!("/home/eng/{}/مخطط المضخات.dwg", "projects/".repeat(12));
        let l = label(Path::new(&deep));
        assert!(l.starts_with("\u{200E}\u{2068}مخطط المضخات.dwg\u{2069} \u{2014} \u{2068}/home/"), "{l}");
        assert!(l.chars().count() <= LABEL_MAX + 5, "{} chars (5 of them invisible bidi marks)", l.chars().count());
        assert!(l.contains('\u{2026}'));
        assert_eq!(label(Path::new("/a/R&D.dxf")), "\u{200E}\u{2068}R&&D.dxf\u{2069} \u{2014} \u{2068}/a\u{2069}");
    }
}
