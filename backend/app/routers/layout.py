from fastapi import APIRouter
from pydantic import BaseModel

from app.db import connect

router = APIRouter()


class LayoutItem(BaseModel):
    widget_id: str
    position: int
    col_span: int = 1


@router.get("/layout")
def get_layout():
    with connect() as conn:
        rows = conn.execute(
            "SELECT widget_id, position, col_span FROM layout ORDER BY position ASC"
        ).fetchall()
    return [dict(row) for row in rows]


@router.post("/layout")
def save_layout(items: list[LayoutItem]):
    with connect() as conn:
        conn.execute("DELETE FROM layout")
        conn.executemany(
            "INSERT INTO layout (widget_id, position, col_span) VALUES (?, ?, ?)",
            [(item.widget_id, item.position, item.col_span) for item in items],
        )
    return {"ok": True}
