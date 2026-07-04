import os

APP_NAME = "canvas-hub"


PORT = 8742

def app_data_dir() -> str:
    base = os.path.expanduser(f"~/Library/Application Support/{APP_NAME}")
    os.makedirs(base, exist_ok=True)
    return base


def db_path() -> str:
    return os.path.join(app_data_dir(), "canvas-hub.db")
