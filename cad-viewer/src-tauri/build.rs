fn main() {
    // App commands get permissions generated (`allow-<command>`), so the page can only call
    // the ones granted in capabilities/default.json.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "pick_file",
        "read_file",
        "take_pending",
        "save_file",
        "write_file",
        "set_modified",
        "close_window",
        "set_theme_menu",
        "print_pdf",
        "recent_files",
        "add_recent",
        "clear_recent",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run the Tauri build script");
}
