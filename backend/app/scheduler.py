import logging
import os

from apscheduler.schedulers.background import BackgroundScheduler

from app.modules.calendar import poller as calendar_poller
from app.modules.canvas import notify_queue, poller as canvas_poller

logger = logging.getLogger(__name__)

DEFAULT_CANVAS_INTERVAL_MINUTES = 30
DEFAULT_CALENDAR_INTERVAL_MINUTES = 10


def _poll_canvas() -> None:
    try:
        new_records = canvas_poller.poll()
        notify_queue.push(new_records)
    except Exception:
        logger.exception("canvas poll job failed")


def _poll_calendar() -> None:
    try:
        calendar_poller.poll()
    except Exception:
        logger.exception("calendar poll job failed")


def start() -> BackgroundScheduler:
    canvas_interval = int(
        os.environ.get("CANVAS_POLL_INTERVAL_MINUTES", DEFAULT_CANVAS_INTERVAL_MINUTES)
    )
    calendar_interval = int(
        os.environ.get("CALENDAR_POLL_INTERVAL_MINUTES", DEFAULT_CALENDAR_INTERVAL_MINUTES)
    )
    scheduler = BackgroundScheduler()
    scheduler.add_job(_poll_canvas, "interval", minutes=canvas_interval, id="canvas_poll")
    scheduler.add_job(_poll_calendar, "interval", minutes=calendar_interval, id="calendar_poll")
    scheduler.start()
    return scheduler
