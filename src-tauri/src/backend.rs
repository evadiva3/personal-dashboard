use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

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
///
/// This is the permanent fix for orphaned backend instances left behind by
/// a previous run (crash, force-quit, or — during `tauri dev` — a hot
/// reload that didn't tear down the old process cleanly). Without this, a
/// stale process silently holding the port makes the freshly spawned
/// backend either fail to bind or leaves two backends racing for the same
/// port, and the frontend ends up talking to whichever one wins, with no
/// indication of why.
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

/// Resolves the directory containing `app/main.py`. Prefers the live
/// source tree (dev builds and `cargo build` run directly from a clone);
/// falls back to the bundled resource copy for installed app bundles,
/// where the source tree alongside the binary doesn't exist.
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

/// Resolves the Python interpreter to run the backend with. Override via
/// the CANVAS_HUB_PYTHON env var for non-conda setups.
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

/// Spawns the FastAPI backend as a localhost-only subprocess. Returns the
/// child handle so the caller can terminate it on app exit.
pub fn spawn(app: &AppHandle) -> std::io::Result<Child> {
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
