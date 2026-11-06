//! The native menu bar. Items that act on the drawing are sent to the page as a `menu`
//! event carrying the item id; the page runs the same action as its toolbar.

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

use crate::{files, recent};

fn item(app: &AppHandle, id: &str, text: &str, accelerator: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, text, true, accelerator)
}

/// Builds the menu bar; returns it with the File > Open Recent submenu (filled later).
pub fn build(app: &AppHandle) -> tauri::Result<(Menu<Wry>, Submenu<Wry>)> {
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

    let theme = SubmenuBuilder::new(app, "&Theme")
        .text("theme:dark", "&Dark")
        .text("theme:light", "&Light")
        .text("theme:mono", "&Monochrome")
        .build()?;
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

    Ok((menu, recent))
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
                let _ = app.emit("menu", id);
            }
        }
    }
}
