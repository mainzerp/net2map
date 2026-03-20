"""Broadcast helpers -- push scan progress/completion to WebSocket clients."""


def _broadcast_progress(scanned: int, total: int, latest_ip: str, success: bool, job_id: str) -> None:
    """Broadcast scan progress to WebSocket clients (fire-and-forget)."""
    try:
        from routers.ws import broadcast_scan_update_sync
        broadcast_scan_update_sync({
            "type": "scan_progress",
            "job_id": job_id,
            "scanned": scanned,
            "total": total,
            "latest_ip": latest_ip,
            "success": success,
        })
    except Exception:
        pass


def _broadcast_scan_complete(job_id: str, status: str, found: int, links: int, duration_ms: int) -> None:
    """Broadcast scan completion to WebSocket clients."""
    try:
        from routers.ws import broadcast_scan_update_sync
        broadcast_scan_update_sync({
            "type": "scan_complete",
            "job_id": job_id,
            "status": status,
            "found": found,
            "links": links,
            "duration_ms": duration_ms,
        })
    except Exception:
        pass
