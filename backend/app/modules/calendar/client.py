import datetime
import threading
import webbrowser
import wsgiref.simple_server
import wsgiref.util

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]

_POLL_INTERVAL_SECONDS = 1


class CalendarAuthError(Exception):
    pass


class CalendarAuthTimeout(CalendarAuthError):
    pass


class CalendarAuthCancelled(CalendarAuthError):
    pass


class _RedirectWSGIApp:
    """Minimal stand-in for google_auth_oauthlib's private
    _RedirectWSGIApp — reimplemented here (rather than importing the
    private class) so run_oauth_flow can drive the loopback server in a
    polling loop instead of one big blocking call, which is what lets it
    notice a cancel request or timeout instead of hanging forever."""

    def __init__(self, success_message: str):
        self.last_request_uri = None
        self._success_message = success_message

    def __call__(self, environ, start_response):
        start_response("200 OK", [("Content-type", "text/plain; charset=utf-8")])
        self.last_request_uri = wsgiref.util.request_uri(environ)
        return [self._success_message.encode("utf-8")]


def run_oauth_flow(
    client_id: str,
    client_secret: str,
    cancel_event: threading.Event,
    timeout_seconds: int = 120,
) -> Credentials:
    """Runs the desktop-app OAuth flow: opens the user's system browser to
    Google's consent screen via a local loopback redirect (NOT a webview —
    this is a native app with no public domain to redirect back to).
    Blocks until the user completes the consent flow, the caller sets
    cancel_event (e.g. via POST /calendar/setup/cancel), or
    timeout_seconds elapses — so callers must run this off the
    request-handling thread.

    Raises CalendarAuthCancelled or CalendarAuthTimeout instead of hanging
    indefinitely if the user closes the browser window without finishing."""
    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }
    flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)

    wsgi_app = _RedirectWSGIApp("The authentication flow has completed. You may close this window.")
    wsgiref.simple_server.WSGIServer.allow_reuse_address = False
    local_server = wsgiref.simple_server.make_server("localhost", 0, wsgi_app)

    try:
        flow.redirect_uri = f"http://localhost:{local_server.server_port}/"
        auth_url, _ = flow.authorization_url()
        webbrowser.open(auth_url, new=1, autoraise=True)

        local_server.timeout = _POLL_INTERVAL_SECONDS
        elapsed = 0
        while wsgi_app.last_request_uri is None:
            if cancel_event.is_set():
                raise CalendarAuthCancelled("calendar OAuth flow was cancelled")
            if elapsed >= timeout_seconds:
                raise CalendarAuthTimeout("timed out waiting for Google sign-in")
            local_server.handle_request()
            elapsed += _POLL_INTERVAL_SECONDS

        authorization_response = wsgi_app.last_request_uri.replace("http", "https")
        flow.fetch_token(authorization_response=authorization_response)
    finally:
        local_server.server_close()

    return flow.credentials


def ensure_fresh(creds: Credentials) -> Credentials:
    """Refreshes the access token using the refresh token if expired.
    Raises CalendarAuthError if there's no refresh token or Google rejects
    the refresh (e.g. the user revoked access)."""
    if not creds.expired:
        return creds

    if not creds.refresh_token:
        raise CalendarAuthError("calendar token expired and no refresh token is stored")

    try:
        creds.refresh(Request())
    except Exception as exc:
        raise CalendarAuthError("could not refresh the calendar token") from exc

    return creds


def get_upcoming_events(creds: Credentials, max_results: int = 10) -> list:
    service = build("calendar", "v3", credentials=creds)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    result = (
        service.events()
        .list(
            calendarId="primary",
            timeMin=now,
            maxResults=max_results,
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )
    return result.get("items", [])


def get_events_in_range(creds: Credentials, time_min: str, time_max: str, max_results: int = 250) -> list:
    """Fetches events within [time_min, time_max) — both ISO 8601, with
    timezone — for the weekly calendar view. Unlike get_upcoming_events
    this is bounded on both ends rather than open-ended from "now"."""
    service = build("calendar", "v3", credentials=creds)
    result = (
        service.events()
        .list(
            calendarId="primary",
            timeMin=time_min,
            timeMax=time_max,
            maxResults=max_results,
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )
    return result.get("items", [])
