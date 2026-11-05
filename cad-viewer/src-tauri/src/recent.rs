//! Recently opened files: kept in the app data folder, shown in File > Open Recent and on the
//! welcome screen. Files that no longer exist are dropped when the list is read.

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

/// Menu label: the file name, then its folder. `&` would be read as a mnemonic marker.
fn label(path: &Path) -> String {
    let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let dir = path.parent().map_or_else(String::new, |d| d.display().to_string());
    format!("{name}  \u{2014}  {dir}").replace('&', "&&")
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

/// The list, after dropping files that were deleted or moved (async: checking files on a
/// disconnected network drive can take a while).
#[tauri::command]
pub async fn recent_files(app: AppHandle) -> Vec<String> {
    let stale = lock(&app.state::<Recent>().list).iter().any(|p| !p.is_file());
    if stale {
        update(&app, |list| list.retain(|p| p.is_file()));
    }
    to_strings(&lock(&app.state::<Recent>().list))
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
