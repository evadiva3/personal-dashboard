use std::process::Child;
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

mod backend;

const CREDENTIALS_STORE: &str = "credentials.json";

struct BackendProcess(Mutex<Option<Child>>);

#[tauri::command]
fn backend_port() -> u16 {
    backend::BACKEND_PORT
}

/// Persists the Canvas domain + token via Tauri's secure store plugin, in
/// the OS app-data directory (never inside the project repo). This is the
/// source of truth used to decide whether to skip onboarding.
#[tauri::command]
fn save_credentials(app: tauri::AppHandle, domain: String, token: String) -> Result<(), String> {
    let store = app.store(CREDENTIALS_STORE).map_err(|e| e.to_string())?;
    store.set("domain", serde_json::json!(domain));
    store.set("token", serde_json::json!(token));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn has_credentials(app: tauri::AppHandle) -> bool {
    match app.store(CREDENTIALS_STORE) {
        Ok(store) => store.has("domain") && store.has("token"),
        Err(_) => false,
    }
}

#[tauri::command]
fn notify_new_assignment(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stored_domain(app: tauri::AppHandle) -> Option<String> {
    let store = app.store(CREDENTIALS_STORE).ok()?;
    store
        .get("domain")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
}

/// Opens the native file picker (images only) for adding a photo panel.
/// The backend does the actual copy into its own app-data directory once
/// it receives this path — local files only, no remote URLs, unlike the
/// books cover resolver.
#[tauri::command]
fn pick_image_file(app: tauri::AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Images", &["jpg", "jpeg", "png", "gif", "webp", "bmp"])
        .blocking_pick_file()?;
    picked.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: if a second OS process of this app is
        // ever launched (a stray manual run, a double-click, or a dev
        // hot-reload that starts the new process before the old one has
        // fully exited), this intercepts that second launch, forwards it
        // here as an event, and exits the second process immediately —
        // so it never gets to create its own window. Without this, two
        // processes each create their own single (correct) window, which
        // looks like "the app spawned a duplicate window" from the
        // outside even though neither process is doing anything wrong on
        // its own.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            backend_port,
            save_credentials,
            has_credentials,
            stored_domain,
            notify_new_assignment,
            pick_image_file
        ])
        .setup(|app| {
            build_tray(app.handle())?;

            let child = backend::spawn(app.handle())
                .expect("failed to spawn backend subprocess");
            app.manage(BackendProcess(Mutex::new(Some(child))));

            // Ensure the app launches on system boot. Idempotent: enable()
            // is a no-op if already registered.
            let autostart = app.autolaunch();
            if !autostart.is_enabled().unwrap_or(false) {
                let _ = autostart.enable();
            }

            // Keep the app (and its tray icon / backend sidecar) alive when the
            // main window is closed instead of quitting the whole process.
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                let state = app.state::<BackendProcess>();
                let taken = state.0.lock().unwrap().take();
                if let Some(mut child) = taken {
                    let _ = child.kill();
                }
            }
        });
}
