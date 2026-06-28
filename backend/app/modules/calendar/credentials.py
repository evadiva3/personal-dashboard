import json
import os

from google.oauth2.credentials import Credentials

from app.config import app_data_dir

_CREDENTIALS_PATH = os.path.join(app_data_dir(), "calendar_credentials.json")


def save(google_credentials: Credentials) -> None:
    """Persists the operational copy of Google OAuth credentials (access
    token, refresh token, expiry, client id/secret) the scheduler uses to
    poll independently. Lives outside the project repo, in the OS
    app-data dir — Tauri's secure store (separate from this file) is the
    source of truth surfaced to the user for the "is calendar connected"
    check."""
    with open(_CREDENTIALS_PATH, "w") as f:
        f.write(google_credentials.to_json())
    os.chmod(_CREDENTIALS_PATH, 0o600)


def load() -> Credentials | None:
    if not os.path.exists(_CREDENTIALS_PATH):
        return None
    with open(_CREDENTIALS_PATH) as f:
        data = json.load(f)
    return Credentials.from_authorized_user_info(data, scopes=data.get("scopes"))


def clear() -> None:
    if os.path.exists(_CREDENTIALS_PATH):
        os.remove(_CREDENTIALS_PATH)
