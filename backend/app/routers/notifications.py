from fastapi import APIRouter

from app.modules.canvas import notify_queue

router = APIRouter()


@router.get("/notifications/new")
def new_notifications():
    return notify_queue.drain()
