import re
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import connect

router = APIRouter()

_PLAYLIST_ID_RE = re.compile(r"open\.spotify\.com/playlist/([A-Za-z0-9]+)")


class PlaylistCreate(BaseModel):
    playlist_url: str
    name: str | None = None


def _embed_url(playlist_url: str) -> str:
    match = _PLAYLIST_ID_RE.search(playlist_url)
    if not match:
        raise HTTPException(status_code=400, detail="not a Spotify playlist URL")
    return f"https://open.spotify.com/embed/playlist/{match.group(1)}?utm_source=generator&theme=0"


@router.get("/spotify")
def list_playlists():
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, name, playlist_url, embed_url, added_at FROM spotify_playlists ORDER BY added_at ASC"
        ).fetchall()
    return [dict(row) for row in rows]


@router.post("/spotify")
def create_playlist(playlist: PlaylistCreate):
    embed_url = _embed_url(playlist.playlist_url.strip())

    with connect() as conn:
        count = conn.execute("SELECT COUNT(*) AS n FROM spotify_playlists").fetchone()["n"]
    name = playlist.name or f"Playlist {count + 1}"

    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        cursor = conn.execute(
            """INSERT INTO spotify_playlists (name, playlist_url, embed_url, added_at)
               VALUES (?, ?, ?, ?)""",
            (name, playlist.playlist_url.strip(), embed_url, now),
        )
        new_id = cursor.lastrowid

    return {
        "id": new_id,
        "name": name,
        "playlist_url": playlist.playlist_url.strip(),
        "embed_url": embed_url,
        "added_at": now,
    }


@router.delete("/spotify/{playlist_id}")
def delete_playlist(playlist_id: int):
    with connect() as conn:
        cursor = conn.execute("DELETE FROM spotify_playlists WHERE id = ?", (playlist_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="playlist not found")
    return {"id": playlist_id}
