from fastapi import APIRouter

from app.db import connect

router = APIRouter()


@router.get("/assignments")
def list_assignments():
    with connect() as conn:
        rows = conn.execute(
            """SELECT id, title, course, due_at, points, status, html_url
               FROM assignments
               ORDER BY (due_at IS NULL), due_at ASC"""
        ).fetchall()
    return [dict(row) for row in rows]
