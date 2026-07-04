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
    layout,
    notifications,
    photos,
    projects,
    setup,
    spotify,
)
from app import scheduler as scheduler_module

logging.basicConfig(level=logging.INFO)


def _exit_if_orphaned(parent_pid: int, poll_seconds: float = 2.0) -> None:
    """Self-terminate if the Tauri parent process disappears (production only).

    Not started in dev mode: in dev, Python intentionally survives
    `cargo tauri dev` Rust hot-reloads so there is no port-down gap while
    Tauri recompiles. When new Tauri starts, clear_stale_backend kills the
    old Python and spawns a fresh one.

    Uses os.kill(parent_pid, 0) rather than getppid()==1 so it works even
    if macOS reparents the orphan to a non-launchd process.
    """
    log = logging.getLogger(__name__)
    while True:
        time.sleep(poll_seconds)
        try:
            os.kill(parent_pid, 0)
        except ProcessLookupError:
            log.info("parent PID %d is gone; exiting", parent_pid)
            os._exit(0)
        except PermissionError:
            pass  # process exists but we can't signal it — still alive

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        init_db()
    except Exception:
        logging.getLogger(__name__).exception("init_db() failed — backend will not start")
        raise
    try:
        app.state.scheduler = scheduler_module.start()
    except Exception:
        logging.getLogger(__name__).exception("scheduler start() failed — backend will not start")
        raise
    yield
    try:
        app.state.scheduler.shutdown(wait=False)
    except Exception:
        pass


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
app.include_router(layout.router)


def main():
    import uvicorn

    if os.environ.get("CANVAS_HUB_DEV") != "1":
        # Production only: watch for Tauri parent dying without cleanup.
        # Skipped in dev so Python survives `cargo tauri dev` hot-reloads.
        parent_pid = os.getppid()
        threading.Thread(
            target=_exit_if_orphaned, args=(parent_pid,), daemon=True
        ).start()

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
