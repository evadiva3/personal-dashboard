from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import connect

router = APIRouter()

_VALID_STATUSES = {"active", "paused", "done"}


class ProjectCreate(BaseModel):
    name: str
    url: str | None = None
    status: str = "active"


class ProjectUpdate(BaseModel):
    status: str


@router.get("/projects")
def list_projects():
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, name, status, url, added_at FROM projects ORDER BY added_at ASC"
        ).fetchall()
    return [dict(row) for row in rows]


@router.post("/projects")
def create_project(project: ProjectCreate):
    name = project.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name must not be empty")
    if project.status not in _VALID_STATUSES:
        raise HTTPException(status_code=400, detail="status must be one of active/paused/done")

    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        cursor = conn.execute(
            "INSERT INTO projects (name, status, url, added_at) VALUES (?, ?, ?, ?)",
            (name, project.status, project.url, now),
        )
        new_id = cursor.lastrowid

    return {"id": new_id, "name": name, "status": project.status, "url": project.url, "added_at": now}


@router.patch("/projects/{project_id}")
def update_project(project_id: int, update: ProjectUpdate):
    if update.status not in _VALID_STATUSES:
        raise HTTPException(status_code=400, detail="status must be one of active/paused/done")

    with connect() as conn:
        cursor = conn.execute(
            "UPDATE projects SET status = ? WHERE id = ?", (update.status, project_id)
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="project not found")
    return {"id": project_id, "status": update.status}


@router.delete("/projects/{project_id}")
def delete_project(project_id: int):
    with connect() as conn:
        cursor = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="project not found")
    return {"id": project_id}
