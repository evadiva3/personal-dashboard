import requests


class CanvasAuthError(Exception):
    pass


def validate_and_fetch_self(domain: str, token: str) -> dict:
    """Calls GET /api/v1/users/self to validate a Canvas PAT.

    Raises CanvasAuthError on any failure. Never logs the token.
    """
    url = f"https://{domain}/api/v1/users/self"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
    except requests.exceptions.Timeout as exc:
        raise CanvasAuthError(f"could not reach that Canvas domain (timed out): {domain}") from exc
    except requests.exceptions.ConnectionError as exc:
        raise CanvasAuthError(f"could not reach that Canvas domain: {domain}") from exc
    except requests.RequestException as exc:
        raise CanvasAuthError(f"could not reach {domain}") from exc

    if resp.status_code != 200:
        raise CanvasAuthError("Canvas rejected the domain/token combination")

    return resp.json()


def get_upcoming_events(domain: str, token: str) -> list:
    url = f"https://{domain}/api/v1/users/self/upcoming_events"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
    except requests.RequestException as exc:
        raise CanvasAuthError(f"could not reach {domain}") from exc

    if resp.status_code != 200:
        raise CanvasAuthError("Canvas rejected the domain/token combination")

    return resp.json()


def get_course_name(domain: str, token: str, course_id: str) -> str | None:
    url = f"https://{domain}/api/v1/courses/{course_id}"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            params={"include[]": "term"},
            timeout=10,
        )
    except requests.RequestException:
        return None

    if resp.status_code != 200:
        return None

    return resp.json().get("name")
