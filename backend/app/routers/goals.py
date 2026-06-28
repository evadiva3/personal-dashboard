from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.db import connect

router = APIRouter()


class GoalCreate(BaseModel):
    text: str
    month: int
    year: int


@router.get("/goals")
def list_goals(month: int = Query(...), year: int = Query(...)):
    with connect() as conn:
        rows = conn.execute(
            """SELECT id, text, done, month, year, created_at FROM goals
               WHERE month = ? AND year = ? ORDER BY created_at ASC""",
            (month, year),
        ).fetchall()
    return [{**dict(row), "done": bool(row["done"])} for row in rows]


@router.post("/goals")
def create_goal(goal: GoalCreate):
    text = goal.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be empty")

    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        cursor = conn.execute(
            "INSERT INTO goals (text, done, month, year, created_at) VALUES (?, 0, ?, ?, ?)",
            (text, goal.month, goal.year, now),
        )
        new_id = cursor.lastrowid

    return {
        "id": new_id,
        "text": text,
        "done": False,
        "month": goal.month,
        "year": goal.year,
        "created_at": now,
    }


@router.patch("/goals/{goal_id}")
def toggle_goal(goal_id: int):
    with connect() as conn:
        row = conn.execute("SELECT done FROM goals WHERE id = ?", (goal_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="goal not found")

        new_done = 0 if row["done"] else 1
        conn.execute("UPDATE goals SET done = ? WHERE id = ?", (new_done, goal_id))
    return {"id": goal_id, "done": bool(new_done)}


@router.delete("/goals/{goal_id}")
def delete_goal(goal_id: int):
    with connect() as conn:
        cursor = conn.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="goal not found")
    return {"id": goal_id}
