import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import connect
from app.modules.books.cover_resolver import resolve_cover

logger = logging.getLogger(__name__)

router = APIRouter()


class BookCreate(BaseModel):
    url: str
    title: str | None = None
    author: str | None = None


@router.get("/books")
def list_books():
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, title, author, cover_url, link, added_at FROM books ORDER BY added_at ASC"
        ).fetchall()
    return [dict(row) for row in rows]


@router.post("/books")
def create_book(book: BookCreate):
    url = book.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="url must not be empty")

    # Cover resolution touches two external services (the source URL's own
    # page, then Google Books) outside our control — a captcha page,
    # rate-limit response, or transient proxy error can return something
    # resolve_cover's targeted except blocks don't anticipate. Adding a
    # book must never fail outright just because its cover couldn't be
    # found; fall back to the placeholder path instead of 500ing.
    try:
        cover_url, resolved_title = resolve_cover(url, title_hint=book.title)
    except Exception:
        logger.exception("cover resolution failed for %s", url)
        cover_url, resolved_title = None, None
    title = book.title or resolved_title or url

    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        cursor = conn.execute(
            """INSERT INTO books (title, author, cover_url, link, added_at)
               VALUES (?, ?, ?, ?, ?)""",
            (title, book.author, cover_url, url, now),
        )
        new_id = cursor.lastrowid

    return {
        "id": new_id,
        "title": title,
        "author": book.author,
        "cover_url": cover_url,
        "link": url,
        "added_at": now,
    }


@router.delete("/books/{book_id}")
def delete_book(book_id: int):
    with connect() as conn:
        cursor = conn.execute("DELETE FROM books WHERE id = ?", (book_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="book not found")
    return {"id": book_id}
