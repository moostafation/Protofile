//! ProtoCAD Viewer desktop shell: a native window around the web app (../src), with native
//! file dialogs, file associations, a single running instance, recent files and a menu bar.

mod files;
mod menu;
mod recent;

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Pages may only navigate within the app (and the Vite dev server in debug builds).
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
        }
        _ => false,
    }
}

fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("ProtoCAD Viewer")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .center();
    // A dark window background avoids a white flash before the page paints. On Linux it would
    // also paint the GTK menu bar, whose text is then unreadable with a light theme.
    let builder = if cfg!(target_os = "linux") { builder } else { builder.background_color(tauri::window::Color(20, 23, 28, 255)) };
    let window = builder
        // The page sets `document.title` to "<file> – ProtoCAD Viewer"; show it in the title bar.
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_navigation(is_app_url)
        .build()?;
    // Large screens: start maximised when the default size does not fit.
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
        if size.width < 1400.0 || size.height < 900.0 {
            let _ = window.maximize();
        }
    }
    Ok(())
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // First plugin: a second launch (e.g. double-clicking another drawing in Explorer)
        // hands its command line to this instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            files::queue_open(app, files::paths_from_args(args, Path::new(&cwd)));
            focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(files::Session::default())
        .setup(|app| {
            let handle = app.handle();
            app.manage(recent::Recent::load(handle));
            let (menu, recent_menu, themes) = menu::build(handle)?;
            app.manage(themes);
            app.state::<recent::Recent>().set_menu(recent_menu);
            let list = recent::list(handle);
            recent::fill_menu(handle, &list)?;
            app.set_menu(menu)?;
            create_main_window(handle)?;
            // args_os: names that are not valid Unicode must not panic (they are reported to the page).
            files::queue_open(handle, files::paths_from_args(std::env::args_os(), &current_dir()));
            Ok(())
        })
        .on_menu_event(menu::on_event)
        .on_window_event(|window, event| match event {
            WindowEvent::DragDrop(drop) => files::on_drag_drop(window.app_handle(), drop),
            // Unsaved changes: the page asks Save / Don't save / Cancel, then closes the window.
            WindowEvent::CloseRequested { api, .. } if files::ask_before_closing(window.app_handle()) => api.prevent_close(),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            files::pick_file,
            files::read_file,
            files::read_sibling,
            files::take_pending,
            files::save_file,
            files::write_file,
            files::set_modified,
            files::close_window,
            menu::set_theme_menu,
            files::print_pdf,
            recent::recent_files,
            recent::add_recent,
            recent::clear_recent,
        ]);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(err) => {
            eprintln!("ProtoCAD Viewer could not start: {err}");
            std::process::exit(1);
        }
    };
    app.run(|_app, _event: RunEvent| {
        // macOS delivers files opened from Finder as an event instead of arguments.
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = _event {
            let paths = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
            files::queue_open(_app, paths);
        }
    });
}
