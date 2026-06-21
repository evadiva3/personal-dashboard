import logging
from datetime import datetime, timezone

from app.db import connect
from app.modules.canvas import credentials
from app.modules.canvas.client import CanvasAuthError, get_course_name, get_upcoming_events

logger = logging.getLogger(__name__)


def _course_name(domain: str, token: str, course_id, conn) -> str | None:
    if course_id is None:
        return None
    course_id = str(course_id)
    row = conn.execute("SELECT name FROM courses WHERE id = ?", (course_id,)).fetchone()
    if row:
        return row["name"]

    name = get_course_name(domain, token, course_id)
    if name:
        conn.execute(
            "INSERT OR REPLACE INTO courses (id, name) VALUES (?, ?)",
            (course_id, name),
        )
    return name


def _normalize(event: dict, domain: str, token: str, conn) -> dict | None:
    """Canvas's upcoming_events endpoint returns a mix of plain Assignment
    objects and CalendarEvent objects that wrap an `assignment` sub-object.
    Normalize both shapes into one record."""
    assignment = event.get("assignment")
    if assignment:
        eid = assignment.get("id") or event.get("id")
        title = event.get("title") or assignment.get("name")
        due_at = assignment.get("due_at")
        points = assignment.get("points_possible")
        course_id = assignment.get("course_id")
        html_url = assignment.get("html_url")
        status = assignment.get("workflow_state", "upcoming")
    else:
        eid = event.get("id")
        title = event.get("name") or event.get("title")
        due_at = event.get("due_at")
        points = event.get("points_possible")
        course_id = event.get("course_id")
        html_url = event.get("html_url")
        status = event.get("workflow_state", "upcoming")

    if eid is None:
        return None

    return {
        "id": str(eid),
        "title": title or "(untitled)",
        "course": _course_name(domain, token, course_id, conn) or "Unknown course",
        "due_at": due_at,
        "points": points,
        "status": status,
        "html_url": html_url,
    }


def poll() -> list[dict]:
    """Polls Canvas for upcoming assignments, upserts them into SQLite,
    and returns the records that are new since the last poll (for
    notifications). No-op if credentials haven't been set up yet."""
    creds = credentials.load()
    if not creds:
        return []

    try:
        events = get_upcoming_events(creds["domain"], creds["token"])
    except CanvasAuthError:
        logger.warning("canvas poll failed: stored credentials were rejected")
        return []

    now = datetime.now(timezone.utc).isoformat()
    new_records = []

    with connect() as conn:
        # Don't treat the very first poll's results as "new" — that would
        # fire a notification for every existing assignment the moment
        # someone connects their account.
        is_initial_poll = conn.execute("SELECT 1 FROM assignments LIMIT 1").fetchone() is None

        for event in events:
            record = _normalize(event, creds["domain"], creds["token"], conn)
            if record is None:
                continue

            existing = conn.execute(
                "SELECT id FROM assignments WHERE id = ?", (record["id"],)
            ).fetchone()

            if existing is None:
                if not is_initial_poll:
                    new_records.append(record)
                conn.execute(
                    """INSERT INTO assignments
                       (id, title, course, due_at, points, status, html_url, first_seen_at, last_seen_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        record["id"],
                        record["title"],
                        record["course"],
                        record["due_at"],
                        record["points"],
                        record["status"],
                        record["html_url"],
                        now,
                        now,
                    ),
                )
            else:
                conn.execute(
                    """UPDATE assignments
                       SET title=?, course=?, due_at=?, points=?, status=?, html_url=?, last_seen_at=?
                       WHERE id=?""",
                    (
                        record["title"],
                        record["course"],
                        record["due_at"],
                        record["points"],
                        record["status"],
                        record["html_url"],
                        now,
                        record["id"],
                    ),
                )

    return new_records
