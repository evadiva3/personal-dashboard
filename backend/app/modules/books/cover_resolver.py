import logging
import re

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; canvas-hub/1.0)"}


def _google_books_cover(title: str) -> str | None:
    try:
        resp = requests.get(
            "https://www.googleapis.com/books/v1/volumes",
            params={"q": f"intitle:{title}"},
            timeout=10,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None

    for item in resp.json().get("items", []):
        image_links = item.get("volumeInfo", {}).get("imageLinks", {})
        cover = image_links.get("thumbnail") or image_links.get("smallThumbnail")
        if cover:
            return cover
    return None


def resolve_cover(url: str, title_hint: str | None = None) -> tuple[str | None, str | None]:
    """Resolves a cover image URL + a best-guess title from an arbitrary
    URL the user pasted (Amazon, Goodreads, a direct image link, etc).

    Order: direct image -> og:image meta tag -> Google Books API lookup by
    whatever title can be extracted. Returns (cover_url, resolved_title) —
    either may be None if resolution fails at every step; the caller falls
    back to a placeholder icon.
    """
    try:
        resp = requests.get(url, headers=_REQUEST_HEADERS, timeout=10)
    except requests.RequestException:
        logger.warning("could not fetch book cover source URL")
        return None, title_hint

    content_type = resp.headers.get("content-type", "")

    if content_type.startswith("image/"):
        return url, title_hint

    if not content_type.startswith("text/html"):
        return None, title_hint

    soup = BeautifulSoup(resp.text, "html.parser")

    page_title = None
    title_tag = soup.find("title")
    if title_tag and title_tag.text:
        page_title = re.sub(r"\s+", " ", title_tag.text).strip()
    resolved_title = title_hint or page_title

    og_image = soup.find("meta", property="og:image")
    if og_image and og_image.get("content"):
        return og_image["content"], resolved_title

    if resolved_title:
        cover = _google_books_cover(resolved_title)
        if cover:
            return cover, resolved_title

    return None, resolved_title
