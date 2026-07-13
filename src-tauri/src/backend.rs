use std::fs;
use std::io::Write as _;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

pub const BACKEND_PORT: u16 = 8742;

fn port_is_bound(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(150),
    )
    .is_ok()
}

fn clear_stale_backend(port: u16) {
    if !port_is_bound(port) {
        return;
    }

    eprintln!("[canvas-hub] port {port} already in use; killing the existing holder before starting");

    let output = Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}")])
        .output();

    if let Ok(output) = output {
        for pid in String::from_utf8_lossy(&output.stdout).split_whitespace() {
            let _ = Command::new("kill").args(["-9", pid]).status();
        }
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && port_is_bound(port) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn backend_dir(app: &AppHandle) -> PathBuf {
    let source_tree = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../backend");
    if source_tree.join("app").join("main.py").exists() {
        return source_tree;
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("backend");
        if bundled.join("app").join("main.py").exists() {
            return bundled;
        }
    }
    source_tree
}

fn python_executable() -> String {
    if let Ok(path) = std::env::var("CANVAS_HUB_PYTHON") {
        return path;
    }
    let conda_env_python = "/opt/anaconda3/envs/eva-workspace/bin/python";
    if std::path::Path::new(conda_env_python).exists() {
        return conda_env_python.to_string();
    }
    "python3".to_string()
}

fn crash_log_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Library/Application Support/canvas-hub/backend-crashes.log")
}

fn log_crash(exit_code: i32) {
    let path = crash_log_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("[canvas-hub] could not create log dir {}: {e}", parent.display());
            return;
        }
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entry = format!("[{ts}] backend exited with code {exit_code}\n");
    match fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            if let Err(e) = f.write_all(entry.as_bytes()) {
                eprintln!("[canvas-hub] could not write crash log: {e}");
            } else {
                eprintln!("[canvas-hub] crash logged to {}", path.display());
            }
        }
        Err(e) => eprintln!("[canvas-hub] could not open crash log {}: {e}", path.display()),
    }
}

fn do_spawn(app: &AppHandle) -> std::io::Result<Child> {
    clear_stale_backend(BACKEND_PORT);
    let dir = backend_dir(app);
    Command::new(python_executable())
        .arg("-m")
        .arg("app.main")
        .current_dir(dir)
        .env("CANVAS_HUB_DEV", if tauri::is_dev() { "1" } else { "0" })
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
}

pub fn spawn(app: &AppHandle) -> std::io::Result<Arc<Mutex<Option<Child>>>> {
    let child = do_spawn(app)?;
    let slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));

    let app = app.clone();
    let monitor_slot = Arc::clone(&slot);

    std::thread::spawn(move || {
        const MAX_RETRIES: u32 = 3;
        const STABLE_UPTIME_SECS: u64 = 30;

        let mut retries: u32 = 0;
        let mut spawn_time = Instant::now();

        loop {
            let exit_status = {
                let mut guard = monitor_slot.lock().unwrap();
                match guard.as_mut() {
                    None => return,
                    Some(child) => match child.try_wait() {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("[canvas-hub] monitor error: {e}");
                            None
                        }
                    },
                }
            };

            if let Some(status) = exit_status {
                *monitor_slot.lock().unwrap() = None;

                let code = status.code().unwrap_or(-1);
                if code == 0 {
                    return;
                }

                log_crash(code);

                if retries >= MAX_RETRIES {
                    eprintln!(
                        "[canvas-hub] backend crashed {MAX_RETRIES} times in a row; giving up"
                    );
                    return;
                }

                retries += 1;
                eprintln!(
                    "[canvas-hub] backend exited (code {code}); restarting in 2 s \
                     ({retries}/{MAX_RETRIES})"
                );
                std::thread::sleep(Duration::from_secs(2));

                match do_spawn(&app) {
                    Ok(new_child) => {
                        *monitor_slot.lock().unwrap() = Some(new_child);
                        spawn_time = Instant::now();
                    }
                    Err(e) => {
                        eprintln!("[canvas-hub] failed to restart backend: {e}");
                        return;
                    }
                }
            } else {
                if spawn_time.elapsed().as_secs() >= STABLE_UPTIME_SECS {
                    retries = 0;
                }
            }

            std::thread::sleep(Duration::from_millis(500));
        }
    });

    Ok(slot)
}
