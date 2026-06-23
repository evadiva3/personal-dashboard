import os
import shutil
import uuid

from app.config import app_data_dir

_ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}


def _photos_dir() -> str:
    path = os.path.join(app_data_dir(), "photos")
    os.makedirs(path, exist_ok=True)
    return path


class InvalidImageError(Exception):
    pass


def save_photo_file(source_path: str) -> str:
    """Copies a user-picked image into the app-data directory (never the
    project repo) under a generated name, and returns the stored filename.
    Local files only — no remote URLs, no scraping, unlike the books
    cover resolver."""
    if not os.path.isfile(source_path):
        raise InvalidImageError(f"file not found: {source_path}")

    ext = os.path.splitext(source_path)[1].lower()
    if ext not in _ALLOWED_EXTENSIONS:
        raise InvalidImageError(f"unsupported image type: {ext}")

    stored_name = f"{uuid.uuid4().hex}{ext}"
    dest_path = os.path.join(_photos_dir(), stored_name)
    shutil.copyfile(source_path, dest_path)
    return stored_name


def photo_file_path(stored_name: str) -> str:
    return os.path.join(_photos_dir(), stored_name)


def delete_photo_file(stored_name: str) -> None:
    path = photo_file_path(stored_name)
    if os.path.exists(path):
        os.remove(path)
