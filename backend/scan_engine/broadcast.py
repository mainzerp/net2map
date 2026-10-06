"""Broadcast helpers -- push scan progress/completion to WebSocket clients.

Distribution: when Redis is available, updates are published to the
``net2map:scan_updates`` pub/sub channel so they also reach WebSocket clients
connected to another process (e.g. scans running inside a Celery worker). The
web process runs a subscriber (started lazily on the first WebSocket connect
in routers/ws.py) that forwards channel messages to its local connections.
Without Redis, updates are delivered in-process exactly as before.
"""
import json

SCAN_UPDATES_CHANNEL = "net2map:scan_updates"


def _broadcast(payload: dict) -> None:
    """Distribute a scan update to WebSocket clients (fire-and-forget)."""
    try:
        from shared.redis_client import get_redis
        r = get_redis()
        if r:
            r.publish(SCAN_UPDATES_CHANNEL, json.dumps(payload, default=str))
            return
    except Exception:
        pass
    # In-memory fallback: direct local delivery (no Redis available)
    try:
        from routers.ws import broadcast_scan_update_sync
        broadcast_scan_update_sync(payload)
    except Exception:
        pass


def _broadcast_progress(scanned: int, total: int, latest_ip: str, success: bool, job_id: str) -> None:
    """Broadcast scan progress to WebSocket clients (fire-and-forget)."""
    _broadcast({
        "type": "scan_progress",
        "job_id": job_id,
        "scanned": scanned,
        "total": total,
        "latest_ip": latest_ip,
        "success": success,
    })


def _broadcast_scan_complete(job_id: str, status: str, found: int, links: int, duration_ms: int) -> None:
    """Broadcast scan completion to WebSocket clients."""
    _broadcast({
        "type": "scan_complete",
        "job_id": job_id,
        "status": status,
        "found": found,
        "links": links,
        "duration_ms": duration_ms,
    })
