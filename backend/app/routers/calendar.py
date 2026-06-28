import datetime
import logging
import threading

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.modules.calendar import credentials, poller
from app.modules.calendar.client import CalendarAuthCancelled, CalendarAuthTimeout, run_oauth_flow

router = APIRouter()
logger = logging.getLogger(__name__)

# How long to wait for the user to finish Google's consent screen before
# giving up. Matches the cap run_oauth_flow enforces on the loopback
# server, so a closed/abandoned browser window can't wedge /calendar/setup
# forever.
_OAUTH_TIMEOUT_SECONDS = 120

_status_lock = threading.Lock()
_status: dict = {"state": "idle", "error": None}
# Identifies the in-progress attempt (if any). A background thread only
# writes _status if this is still *its* event — once cancelled or
# superseded by a newer attempt, its eventual result is discarded instead
# of clobbering newer state.
_active_cancel_event: threading.Event | None = None


def _set_status_if_current(cancel_event: threading.Event, state: str, error: str | None = None) -> None:
    with _status_lock:
        if _active_cancel_event is not cancel_event:
            return
        _status["state"] = state
        _status["error"] = error


class CalendarSetupRequest(BaseModel):
    client_id: str
    client_secret: str


def _run_oauth_flow_background(client_id: str, client_secret: str, cancel_event: threading.Event) -> None:
    try:
        google_credentials = run_oauth_flow(client_id, client_secret, cancel_event, _OAUTH_TIMEOUT_SECONDS)
        credentials.save(google_credentials)
        poller.poll()  # populate "Up next" immediately instead of waiting for the next scheduled poll
        _set_status_if_current(cancel_event, "success")
    except CalendarAuthCancelled:
        _set_status_if_current(cancel_event, "cancelled")
    except CalendarAuthTimeout as exc:
        _set_status_if_current(cancel_event, "timeout", str(exc))
    except Exception as exc:
        logger.exception("calendar OAuth flow failed")
        _set_status_if_current(cancel_event, "error", str(exc))


@router.post("/calendar/setup")
def setup(req: CalendarSetupRequest):
    global _active_cancel_event
    with _status_lock:
        if _status["state"] == "in_progress":
            return JSONResponse(
                status_code=429,
                content={"success": False, "error": "a calendar setup request is already in progress"},
            )
        cancel_event = threading.Event()
        _active_cancel_event = cancel_event
        _status["state"] = "in_progress"
        _status["error"] = None

    # run_oauth_flow() opens the system browser and blocks until the user
    # completes the consent screen, cancels, or the timeout elapses —
    # potentially minutes. Running it inline would hang this request
    # exactly like the Canvas /setup hang we already fixed once; the
    # frontend polls /calendar/setup/status instead.
    threading.Thread(
        target=_run_oauth_flow_background, args=(req.client_id, req.client_secret, cancel_event), daemon=True
    ).start()
    return {"status": "started"}


@router.get("/calendar/setup/status")
def setup_status():
    with _status_lock:
        return dict(_status)


@router.post("/calendar/setup/cancel")
def setup_cancel():
    """Signals the in-progress OAuth attempt (if any) to close its
    loopback server, and immediately frees /calendar/setup to accept a new
    request rather than waiting for the background thread to notice the
    cancellation on its own."""
    global _active_cancel_event
    with _status_lock:
        if _active_cancel_event is not None:
            _active_cancel_event.set()
        _active_cancel_event = None
        _status["state"] = "idle"
        _status["error"] = None
    return {"success": True}


@router.get("/calendar/upcoming")
def upcoming():
    if credentials.load() is None:
        return []

    events = poller.latest_upcoming()
    if not events:
        # Likely the first request after an app restart, before the
        # scheduled poll has run yet — fetch once now instead of showing
        # an empty list for up to a full poll interval.
        events = poller.poll()
    return events


@router.get("/calendar/week")
def week(week_start: str | None = None):
    """Returns events for the Mon-Sun week containing week_start (or the
    current week if omitted), in the shape the weekly bento view renders:
    id/title/start/end (ISO 8601, local timezone)/all_day."""
    if credentials.load() is None:
        return []

    if week_start:
        try:
            anchor = datetime.date.fromisoformat(week_start)
        except ValueError:
            raise HTTPException(status_code=400, detail="week_start must be an ISO date (YYYY-MM-DD)")
    else:
        anchor = datetime.date.today()

    monday = anchor - datetime.timedelta(days=anchor.weekday())
    return poller.week(monday)


@router.post("/calendar/disconnect")
def disconnect():
    global _active_cancel_event
    creds = credentials.load()
    if creds is not None and creds.token:
        try:
            requests.post(
                "https://oauth2.googleapis.com/revoke",
                params={"token": creds.token},
                timeout=5,
            )
        except requests.RequestException:
            pass  # best-effort; clearing local state is what matters

    credentials.clear()
    poller.clear_cache()
    with _status_lock:
        _active_cancel_event = None
        _status["state"] = "idle"
        _status["error"] = None
    return {"success": True}
