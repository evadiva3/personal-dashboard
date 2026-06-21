import json
import os

from app.config import app_data_dir

_CREDENTIALS_PATH = os.path.join(app_data_dir(), "canvas_credentials.json")


def save(domain: str, token: str) -> None:
    """Persists the operational copy of credentials the scheduler polls
    with. Lives outside the project repo, in the OS app-data dir — Tauri's
    secure store (separate from this file) remains the source of truth
    surfaced to the user."""
    with open(_CREDENTIALS_PATH, "w") as f:
        json.dump({"domain": domain, "token": token}, f)
    os.chmod(_CREDENTIALS_PATH, 0o600)


def load() -> dict | None:
    if not os.path.exists(_CREDENTIALS_PATH):
        return None
    with open(_CREDENTIALS_PATH) as f:
        return json.load(f)
