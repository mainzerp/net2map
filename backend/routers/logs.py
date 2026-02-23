"""Structured log buffer endpoint."""
import json

from fastapi import APIRouter

from shared.state import LOG_BUFFER, LOG_BUFFER_LOCK

router = APIRouter()


@router.get("/api/logs")
def get_logs(limit: int = 200, level: str = "", event_prefix: str = "", q: str = ""):
    """Return recent structured backend logs."""
    clamped = max(1, min(2000, int(limit)))
    level_filter = level.strip().upper()
    event_filter = event_prefix.strip()
    query = q.strip().lower()
    with LOG_BUFFER_LOCK:
        rows = list(LOG_BUFFER)
    if level_filter:
        rows = [r for r in rows if str(r.get("level", "")).upper() == level_filter]
    if event_filter:
        rows = [r for r in rows if str(r.get("event", "")).startswith(event_filter)]
    if query:
        rows = [
            r for r in rows
            if query in json.dumps(r, ensure_ascii=False).lower()
        ]
    return rows[-clamped:]
