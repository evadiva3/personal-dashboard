from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import connect

router = APIRouter()


class EventCreate(BaseModel):
    label: str
    date: str


@router.get("/events")
def list_events():
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, label, date, added_at FROM events ORDER BY date ASC"
        ).fetchall()
    return [dict(row) for row in rows]


@router.post("/events")
def create_event(event: EventCreate):
    label = event.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="label must not be empty")

    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        cursor = conn.execute(
            "INSERT INTO events (label, date, added_at) VALUES (?, ?, ?)",
            (label, event.date, now),
        )
        new_id = cursor.lastrowid

    return {"id": new_id, "label": label, "date": event.date, "added_at": now}


@router.delete("/events/{event_id}")
def delete_event(event_id: int):
    with connect() as conn:
        cursor = conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="event not found")
    return {"id": event_id}
