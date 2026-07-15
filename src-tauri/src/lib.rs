use std::process::Child;
use std::sync::{Arc, Mutex};

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
const CALENDAR_STORE: &str = "calendar_credentials.json";
const PREFERENCES_STORE: &str = "preferences.json";

struct BackendProcess(Arc<Mutex<Option<Child>>>);

#[tauri::command]
fn backend_port() -> u16 {
    backend::BACKEND_PORT
}

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

#[tauri::command]
fn disconnect_canvas(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.store(CREDENTIALS_STORE).map_err(|e| e.to_string())?;
    store.delete("domain");
    store.delete("token");
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_calendar_credentials(app: tauri::AppHandle, client_id: String, client_secret: String) -> Result<(), String> {
    let store = app.store(CALENDAR_STORE).map_err(|e| e.to_string())?;
    store.set("client_id", serde_json::json!(client_id));
    store.set("client_secret", serde_json::json!(client_secret));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn has_calendar_credentials(app: tauri::AppHandle) -> bool {
    match app.store(CALENDAR_STORE) {
        Ok(store) => store.has("client_id") && store.has("client_secret"),
        Err(_) => false,
    }
}

#[tauri::command]
fn disconnect_calendar(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.store(CALENDAR_STORE).map_err(|e| e.to_string())?;
    store.delete("client_id");
    store.delete("client_secret");
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_onboarding_seen(app: tauri::AppHandle) -> bool {
    match app.store(CALENDAR_STORE) {
        Ok(store) => store.get("onboarding_seen").and_then(|v| v.as_bool()).unwrap_or(false),
        Err(_) => false,
    }
}

#[tauri::command]
fn set_calendar_onboarding_seen(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.store(CALENDAR_STORE).map_err(|e| e.to_string())?;
    store.set("onboarding_seen", serde_json::json!(true));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_calendar_onboarding_seen(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.store(CALENDAR_STORE).map_err(|e| e.to_string())?;
    store.delete("onboarding_seen");
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_display_name(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let store = app.store(PREFERENCES_STORE).map_err(|e| e.to_string())?;
    store.set("display_name", serde_json::json!(name));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn display_name(app: tauri::AppHandle) -> Option<String> {
    let store = app.store(PREFERENCES_STORE).ok()?;
    store
        .get("display_name")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
}

#[tauri::command]
async fn pick_image_file(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Images", &["jpg", "jpeg", "png", "gif", "webp", "bmp"])
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
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
            disconnect_canvas,
            notify_new_assignment,
            pick_image_file,
            save_calendar_credentials,
            has_calendar_credentials,
            disconnect_calendar,
            calendar_onboarding_seen,
            set_calendar_onboarding_seen,
            clear_calendar_onboarding_seen,
            save_display_name,
            display_name
        ])
        .setup(|app| {
            build_tray(app.handle())?;

            let child_slot = backend::spawn(app.handle())
                .expect("failed to spawn backend subprocess");
            app.manage(BackendProcess(child_slot));

            let autostart = app.autolaunch();
            if !autostart.is_enabled().unwrap_or(false) {
                let _ = autostart.enable();
            }

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
