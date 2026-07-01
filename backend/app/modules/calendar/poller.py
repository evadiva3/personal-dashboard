import datetime
import logging
import threading

from app.modules.calendar import credentials
from app.modules.calendar.client import (
    CalendarAuthError,
    ensure_fresh,
    get_events_in_range,
    get_upcoming_events,
)

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_latest_upcoming: list[dict] = []


def _day_label(dt: datetime.datetime, today: datetime.date) -> str:
    delta = (dt.date() - today).days
    if delta == 0:
        return "Today"
    if delta == 1:
        return "Tomorrow"
    return dt.strftime("%a")


def _format_time(event: dict) -> str:
    """Matches the shape the frontend's mock data used: a pre-formatted
    "Today, 2:00 PM" style string, so renderUpNext() needs no changes."""
    start = event.get("start", {})
    today = datetime.datetime.now().date()

    if "dateTime" in start:
        dt = datetime.datetime.fromisoformat(start["dateTime"]).astimezone()
        return f"{_day_label(dt, today)}, {dt.strftime('%-I:%M %p')}"

    date = datetime.date.fromisoformat(start["date"])
    dt = datetime.datetime.combine(date, datetime.time())
    return f"{_day_label(dt, today)}, All day"


def _normalize(event: dict) -> dict:
    return {
        "time": _format_time(event),
        "label": event.get("summary", "(untitled)"),
    }


def latest_upcoming() -> list[dict]:
    with _lock:
        return list(_latest_upcoming)


def clear_cache() -> None:
    global _latest_upcoming
    with _lock:
        _latest_upcoming = []


def poll() -> list[dict]:
    """Fetches upcoming calendar events and caches them for
    GET /calendar/upcoming to serve without hitting Google on every
    dashboard refresh. No-op if calendar hasn't been connected."""
    global _latest_upcoming

    creds = credentials.load()
    if creds is None:
        return []

    try:
        creds = ensure_fresh(creds)
        credentials.save(creds)
        events = get_upcoming_events(creds)
    except CalendarAuthError:
        logger.warning("calendar poll failed: stored credentials were rejected")
        return []

    normalized = [_normalize(e) for e in events]
    with _lock:
        _latest_upcoming = normalized
    return normalized


def _event_datetime(node: dict, local_tz) -> tuple[datetime.datetime, bool]:
    """Returns (datetime, is_all_day) for a Calendar API start/end node,
    which is either {"dateTime": ...} (timed) or {"date": ...} (all-day,
    with no time/timezone component of its own)."""
    if "dateTime" in node:
        return datetime.datetime.fromisoformat(node["dateTime"]), False
    date = datetime.date.fromisoformat(node["date"])
    return datetime.datetime.combine(date, datetime.time(), tzinfo=local_tz), True


def _normalize_week_event(event: dict, local_tz) -> dict:
    start_dt, all_day = _event_datetime(event.get("start", {}), local_tz)
    end_dt, _ = _event_datetime(event.get("end", {}), local_tz)
    return {
        "id": event.get("id"),
        "title": event.get("summary", "(untitled)"),
        "start": start_dt.isoformat(),
        "end": end_dt.isoformat(),
        "all_day": all_day,
    }


def week(monday: datetime.date) -> list[dict]:
    """Fetches events for the week starting on the given Monday (local
    time), through the following Monday — i.e. Mon 00:00 to Sun 23:59:59.
    Returns [] if the calendar isn't connected or credentials are stale,
    same fallback behavior as poll()."""
    creds = credentials.load()
    if creds is None:
        return []

    try:
        creds = ensure_fresh(creds)
        credentials.save(creds)
    except CalendarAuthError:
        logger.warning("calendar week fetch failed: stored credentials were rejected")
        return []

    local_tz = datetime.datetime.now().astimezone().tzinfo
    time_min = datetime.datetime.combine(monday, datetime.time(), tzinfo=local_tz)
    time_max = time_min + datetime.timedelta(days=7)

    events = get_events_in_range(creds, time_min.isoformat(), time_max.isoformat())
    return [_normalize_week_event(e, local_tz) for e in events]
