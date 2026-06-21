from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import connect

router = APIRouter()


class ChecklistItemCreate(BaseModel):
    text: str


@router.get("/checklist")
def list_items():
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, text, done, created_at FROM checklist_items ORDER BY created_at ASC"
        ).fetchall()
    return [{**dict(row), "done": bool(row["done"])} for row in rows]


@router.post("/checklist")
def create_item(item: ChecklistItemCreate):
    text = item.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be empty")

    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        cursor = conn.execute(
            "INSERT INTO checklist_items (text, done, created_at) VALUES (?, 0, ?)",
            (text, now),
        )
        new_id = cursor.lastrowid
    return {"id": new_id, "text": text, "done": False, "created_at": now}


@router.patch("/checklist/{item_id}")
def toggle_item(item_id: int):
    with connect() as conn:
        row = conn.execute(
            "SELECT done FROM checklist_items WHERE id = ?", (item_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="item not found")

        new_done = 0 if row["done"] else 1
        conn.execute(
            "UPDATE checklist_items SET done = ? WHERE id = ?", (new_done, item_id)
        )
    return {"id": item_id, "done": bool(new_done)}


@router.delete("/checklist/{item_id}")
def delete_item(item_id: int):
    with connect() as conn:
        cursor = conn.execute("DELETE FROM checklist_items WHERE id = ?", (item_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="item not found")
    return {"id": item_id}
