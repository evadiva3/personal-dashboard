use std::fs;
use std::io::Write as _;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

/// Fixed localhost port the backend listens on. Must match `PORT` in
/// backend/app/config.py.
pub const BACKEND_PORT: u16 = 8742;

fn port_is_bound(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(150),
    )
    .is_ok()
}

/// Kills whatever process is already listening on `BACKEND_PORT` and waits
/// for the port to actually free up before returning.
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

/// Resolves the directory containing `app/main.py`.
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

/// Resolves the Python interpreter.
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

/// Returns the hardcoded crash-log path in the macOS app-data directory.
/// Uses `dirs::home_dir()` so it works on the monitor thread without
/// needing a `tauri::AppHandle` (Tauri's path resolver can fail off the
/// main thread).
fn crash_log_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Library/Application Support/canvas-hub/backend-crashes.log")
}

/// Appends a crash entry (timestamp + exit code) to the log file.
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

/// Internal: spawn one backend process.
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

/// Spawns the FastAPI backend and starts a background monitor thread that
/// restarts it on crash (up to 3 consecutive quick crashes). Returns a shared
/// slot so `lib.rs` can kill the process on app exit.
pub fn spawn(app: &AppHandle) -> std::io::Result<Arc<Mutex<Option<Child>>>> {
    let child = do_spawn(app)?;
    let slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));

    let app = app.clone();
    let monitor_slot = Arc::clone(&slot);

    std::thread::spawn(move || {
        const MAX_RETRIES: u32 = 3;
        // Reset the retry counter after the backend has been stable this long.
        const STABLE_UPTIME_SECS: u64 = 30;

        let mut retries: u32 = 0;
        let mut spawn_time = Instant::now();

        loop {
            // ── check process status (lock held only for this block) ──────────
            let exit_status = {
                let mut guard = monitor_slot.lock().unwrap();
                match guard.as_mut() {
                    // Slot cleared by shutdown handler → intentional app exit,
                    // stop monitoring.
                    None => return,
                    Some(child) => match child.try_wait() {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("[canvas-hub] monitor error: {e}");
                            None
                        }
                    },
                }
                // guard dropped here — lock released before any heavy work
            };

            // ── act on result (no lock held) ──────────────────────────────────
            if let Some(status) = exit_status {
                // Clear the slot (brief re-acquire) so the shutdown handler
                // won't try to kill an already-dead PID.
                *monitor_slot.lock().unwrap() = None;

                // code == 0 is a clean self-exit (e.g. _exit_if_orphaned when
                // Tauri hot-reloads). Tauri will spawn a fresh backend itself,
                // so don't restart here.
                //
                // Everything else — non-zero exit codes AND signal kills (SIGKILL
                // from `kill -9`, SIGSEGV, etc.) — is an unexpected crash.
                // status.code() returns None on Unix for signal-killed processes;
                // we map that to -1 so it falls through to the restart path.
                //
                // NOTE: Tauri's own shutdown kill is handled by the slot being
                // set to None *before* kill() is called. The monitor sees None
                // above and returns before ever reaching this branch.
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
                // Still running — reset retry counter once stable long enough.
                if spawn_time.elapsed().as_secs() >= STABLE_UPTIME_SECS {
                    retries = 0;
                }
            }

            // Lock is NOT held here.
            std::thread::sleep(Duration::from_millis(500));
        }
    });

    Ok(slot)
}
