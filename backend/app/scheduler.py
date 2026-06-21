import logging
import os

from apscheduler.schedulers.background import BackgroundScheduler

from app.modules.canvas import notify_queue, poller

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_MINUTES = 30


def _poll_canvas() -> None:
    try:
        new_records = poller.poll()
        notify_queue.push(new_records)
    except Exception:
        logger.exception("canvas poll job failed")


def start() -> BackgroundScheduler:
    interval = int(os.environ.get("CANVAS_POLL_INTERVAL_MINUTES", DEFAULT_INTERVAL_MINUTES))
    scheduler = BackgroundScheduler()
    scheduler.add_job(_poll_canvas, "interval", minutes=interval, id="canvas_poll")
    scheduler.start()
    return scheduler
