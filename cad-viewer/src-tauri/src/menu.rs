//! The native menu bar. Items that act on the drawing are sent to the page as a `menu`
//! event carrying the item id; the page runs the same action as its toolbar.

use std::sync::Mutex;

use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use crate::{files, recent};

fn item(app: &AppHandle, id: &str, text: &str, accelerator: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, text, true, accelerator)
}

/// View > Theme items: checked for the active theme (`theme:dark`, `theme:light`, `theme:mono`).
pub struct ThemeMenu(Mutex<Vec<CheckMenuItem<Wry>>>);

impl ThemeMenu {
    fn check(&self, id: &str) {
        for item in crate::files::lock(&self.0).iter() {
            let _ = item.set_checked(item.id().as_ref() == id);
        }
    }
}

/// The page tells which theme is active (at start and when it changes in Settings).
#[tauri::command]
pub fn set_theme_menu(themes: State<'_, ThemeMenu>, theme: String) {
    themes.check(&format!("theme:{theme}"));
}

/// Builds the menu bar; returns it with the File > Open Recent submenu (filled later) and the theme items.
pub fn build(app: &AppHandle) -> tauri::Result<(Menu<Wry>, Submenu<Wry>, ThemeMenu)> {
    let info = app.package_info();
    let about = PredefinedMenuItem::about(
        app,
        Some("&About ProtoCAD Viewer"),
        Some(AboutMetadata {
            name: Some(info.name.clone()),
            version: Some(info.version.to_string()),
            comments: Some("Viewer for DWG, DXF, DGN, HP-GL, PDF and image files, with measuring, PDF printing and an AI assistant.".into()),
            license: Some("GPL-3.0".into()),
            ..Default::default()
        }),
    )?;
    let recent = SubmenuBuilder::with_id(app, "recent", "Open &Recent").build()?;

    let mut file = SubmenuBuilder::new(app, "&File")
        .item(&item(app, "open", "&Open\u{2026}", Some("CmdOrCtrl+O"))?)
        .item(&recent)
        .separator()
        .item(&item(app, "save", "&Save", Some("CmdOrCtrl+S"))?)
        .item(&item(app, "save-as", "Save &As DXF\u{2026}", Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&item(app, "print", "&Print\u{2026}", Some("CmdOrCtrl+P"))?)
        .item(&item(app, "export-pdf", "&Export PDF\u{2026}", Some("CmdOrCtrl+E"))?);
    if !cfg!(target_os = "macos") {
        file = file.separator().item(&item(app, "quit", "&Quit", Some("CmdOrCtrl+Q"))?);
    }
    let file = file.build()?;

    let themes = vec![
        CheckMenuItem::with_id(app, "theme:dark", "&Dark", true, true, None::<&str>)?,
        CheckMenuItem::with_id(app, "theme:light", "&Light", true, false, None::<&str>)?,
        CheckMenuItem::with_id(app, "theme:mono", "&Monochrome", true, false, None::<&str>)?,
    ];
    let theme = SubmenuBuilder::new(app, "&Theme").item(&themes[0]).item(&themes[1]).item(&themes[2]).build()?;
    let view = SubmenuBuilder::new(app, "&View")
        .item(&item(app, "zoom-extents", "Zoom &Extents", None)?)
        .item(&item(app, "zoom-in", "Zoom &In", Some("CmdOrCtrl+="))?)
        .item(&item(app, "zoom-out", "Zoom &Out", Some("CmdOrCtrl+-"))?)
        .separator()
        .item(&theme)
        .build()?;

    let mut help = SubmenuBuilder::new(app, "&Help").text("formats", "&Supported Formats");
    if !cfg!(target_os = "macos") {
        help = help.separator().item(&about);
    }
    let help = help.build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        // macOS: the first submenu is the application menu; Edit makes copy/paste work in text fields.
        let app_menu = SubmenuBuilder::new(app, info.name.clone())
            .item(&about)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &help])?
    };
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&file, &view, &help])?;

    Ok((menu, recent, ThemeMenu(Mutex::new(themes))))
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "quit" => {
            if !files::ask_before_closing(app) {
                app.exit(0);
            }
        }
        "recent-clear" => recent::clear(app),
        _ => {
            if let Some(index) = id.strip_prefix("recent:").and_then(|i| i.parse().ok()) {
                recent::open_entry(app, index);
            } else {
                // Theme items behave as radio items (GTK and Windows toggle only the clicked one).
                if id.starts_with("theme:") {
                    app.state::<ThemeMenu>().check(id);
                }
                let _ = app.emit("menu", id);
            }
        }
    }
}
