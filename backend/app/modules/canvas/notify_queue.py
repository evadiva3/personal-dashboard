import threading

_lock = threading.Lock()
_pending: list[dict] = []


def push(records: list[dict]) -> None:
    if not records:
        return
    with _lock:
        _pending.extend(records)


def drain() -> list[dict]:
    with _lock:
        records = list(_pending)
        _pending.clear()
    return records
