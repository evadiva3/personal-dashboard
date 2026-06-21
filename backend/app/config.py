import os

APP_NAME = "canvas-hub"


PORT = 8742

# Backend-local state (SQLite db, cached credentials) lives outside the
# project repo entirely, in the OS per-user application support directory 
# never inside the cloned git working tree.
def app_data_dir() -> str:
    base = os.path.expanduser(f"~/Library/Application Support/{APP_NAME}")
    os.makedirs(base, exist_ok=True)
    return base


def db_path() -> str:
    return os.path.join(app_data_dir(), "canvas-hub.db")
