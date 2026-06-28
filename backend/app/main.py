import logging
import os
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import PORT
from app.db import init_db
from app.routers import (
    assignments,
    books,
    calendar,
    checklist,
    events,
    goals,
    health,
    notifications,
    photos,
    projects,
    setup,
    spotify,
)
from app import scheduler as scheduler_module

logging.basicConfig(level=logging.INFO)


def _exit_if_orphaned(poll_seconds: float = 2.0) -> None:
    """Self-terminate if the Tauri parent process disappears.

    Guards against a leaked subprocess when the GUI is force-killed
    (e.g. kill -9, Activity Monitor) rather than exited normally, in
    which case Tauri's own ExitRequested cleanup never runs.
    """
    parent_pid = os.getppid()
    while True:
        time.sleep(poll_seconds)
        if os.getppid() != parent_pid:
            os._exit(0)

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    app.state.scheduler = scheduler_module.start()
    yield
    app.state.scheduler.shutdown(wait=False)


app = FastAPI(title="canvas-hub backend", lifespan=lifespan)


_cors_kwargs = {
    "allow_origins": [
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
    ],
    "allow_methods": ["GET", "POST", "PATCH", "DELETE"],
    "allow_headers": ["*"],
}

# Dev-only: also accept any http://127.0.0.1:<port> / http://localhost:<port>
# origin. Empirically, the dev webview was observed sending
# Origin: http://127.0.0.1:1430
if os.environ.get("CANVAS_HUB_DEV") == "1":
    _cors_kwargs["allow_origin_regex"] = r"http://(127\.0\.0\.1|localhost):\d+"

app.add_middleware(CORSMiddleware, **_cors_kwargs)

app.include_router(health.router)
app.include_router(setup.router)
app.include_router(assignments.router)
app.include_router(notifications.router)
app.include_router(checklist.router)
app.include_router(calendar.router)
app.include_router(books.router)
app.include_router(projects.router)
app.include_router(goals.router)
app.include_router(events.router)
app.include_router(photos.router)
app.include_router(spotify.router)


def main():
    import uvicorn

    threading.Thread(target=_exit_if_orphaned, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
