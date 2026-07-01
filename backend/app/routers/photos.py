from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.db import connect
from app.modules.photos.storage import InvalidImageError, delete_photo_file, photo_file_path, save_photo_file

router = APIRouter()


class PhotoCreate(BaseModel):
    path: str
    grid_col: int = 0
    grid_row: int = 0
    grid_col_span: int = 1
    grid_row_span: int = 1


class PhotoUpdate(BaseModel):
    grid_col: int | None = None
    grid_row: int | None = None
    grid_col_span: int | None = None
    grid_row_span: int | None = None


@router.get("/photos")
def list_photos():
    with connect() as conn:
        rows = conn.execute(
            """SELECT id, grid_col, grid_row, grid_col_span, grid_row_span, added_at
               FROM photos ORDER BY added_at ASC"""
        ).fetchall()
    return [dict(row) for row in rows]


@router.post("/photos")
def create_photo(photo: PhotoCreate):
    try:
        stored_name = save_photo_file(photo.path)
    except InvalidImageError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        cursor = conn.execute(
            """INSERT INTO photos (src_path, grid_col, grid_row, grid_col_span, grid_row_span, added_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (stored_name, photo.grid_col, photo.grid_row, photo.grid_col_span, photo.grid_row_span, now),
        )
        new_id = cursor.lastrowid

    return {
        "id": new_id,
        "grid_col": photo.grid_col,
        "grid_row": photo.grid_row,
        "grid_col_span": photo.grid_col_span,
        "grid_row_span": photo.grid_row_span,
        "added_at": now,
    }


@router.patch("/photos/{photo_id}")
def update_photo(photo_id: int, update: PhotoUpdate):
    fields = {k: v for k, v in update.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="no fields to update")

    with connect() as conn:
        existing = conn.execute("SELECT id FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="photo not found")

        set_clause = ", ".join(f"{key} = ?" for key in fields)
        conn.execute(
            f"UPDATE photos SET {set_clause} WHERE id = ?", (*fields.values(), photo_id)
        )
    return {"id": photo_id, **fields}


@router.delete("/photos/{photo_id}")
def delete_photo(photo_id: int):
    with connect() as conn:
        row = conn.execute("SELECT src_path FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="photo not found")
        conn.execute("DELETE FROM photos WHERE id = ?", (photo_id,))

    delete_photo_file(row["src_path"])
    return {"id": photo_id}


@router.get("/photos/{photo_id}/file")
def get_photo_file(photo_id: int):
    with connect() as conn:
        row = conn.execute("SELECT src_path FROM photos WHERE id = ?", (photo_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="photo not found")
    return FileResponse(photo_file_path(row["src_path"]))
