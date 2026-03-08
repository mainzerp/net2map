"""Structured log buffer endpoint."""
from fastapi import APIRouter

from shared.state import get_log_entries

router = APIRouter()


@router.get("/api/logs")
def get_logs(limit: int = 200, level: str = "", event_prefix: str = "", q: str = ""):
    """Return recent structured backend logs."""
    return get_log_entries(limit=limit, level=level, event_prefix=event_prefix, query=q)
