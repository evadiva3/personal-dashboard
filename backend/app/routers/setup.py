import logging
import threading

from fastapi import APIRouter, BackgroundTasks
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.db import connect
from app.modules.canvas import credentials, notify_queue, poller
from app.modules.canvas.client import CanvasAuthError, validate_and_fetch_self

router = APIRouter()
logger = logging.getLogger(__name__)

_setup_lock = threading.Lock()


class SetupRequest(BaseModel):
    domain: str
    token: str


@router.post("/setup")
def setup(req: SetupRequest, background_tasks: BackgroundTasks):
    if not _setup_lock.acquire(blocking=False):
        return JSONResponse(
            status_code=429,
            content={"success": False, "error": "a setup request is already in progress"},
        )

    try:
        domain = req.domain.strip().removeprefix("https://").removeprefix("http://").rstrip("/")

        try:
            user = validate_and_fetch_self(domain, req.token)
        except CanvasAuthError as exc:
            logger.info("canvas token validation failed for domain=%s", domain)
            return JSONResponse(status_code=400, content={"success": False, "error": str(exc)})

        credentials.save(domain, req.token)
        background_tasks.add_task(poller.poll)
        return {"success": True, "user": {"id": user.get("id"), "name": user.get("name")}}
    finally:
        _setup_lock.release()


@router.post("/canvas/disconnect")
def disconnect():
    credentials.clear()
    with connect() as conn:
        conn.execute("DELETE FROM assignments")
        conn.execute("DELETE FROM courses")
    notify_queue.drain()
    return {"success": True}
