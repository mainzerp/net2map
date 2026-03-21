"""WebSocket endpoint for real-time scan progress updates."""
import asyncio
import json
import logging
from typing import Set

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, WebSocketException

router = APIRouter()
_log = logging.getLogger(__name__)

# Active WebSocket connections
_clients: Set[WebSocket] = set()
_clients_lock = asyncio.Lock()


async def broadcast_scan_update(data: dict) -> None:
    """Send a scan progress update to all connected WebSocket clients."""
    if not _clients:
        return
    message = json.dumps(data, default=str)
    async with _clients_lock:
        closed = []
        for ws in _clients:
            try:
                await ws.send_text(message)
            except Exception:
                closed.append(ws)
        for ws in closed:
            _clients.discard(ws)


def broadcast_scan_update_sync(data: dict) -> None:
    """Fire-and-forget broadcast from synchronous / threaded code.

    Uses the shared background event loop so it works from scan threads
    and Celery workers without blocking.
    """
    from scan_engine import _get_bg_loop
    try:
        loop = _get_bg_loop()
        asyncio.run_coroutine_threadsafe(broadcast_scan_update(data), loop)
    except Exception:
        pass


@router.websocket("/ws/scan-progress")
async def scan_progress_ws(ws: WebSocket, token: str = Query(default="")):
    # Validate token if auth is enabled
    _authenticate_ws(token)

    await ws.accept()
    async with _clients_lock:
        _clients.add(ws)

    _log.info("WebSocket client connected (%d total)", len(_clients))
    try:
        while True:
            # Keep connection alive; client may send pings or close
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with _clients_lock:
            _clients.discard(ws)
        _log.info("WebSocket client disconnected (%d remaining)", len(_clients))


def _authenticate_ws(token: str) -> None:
    """Validate token for WebSocket connections.

    Accepts either a single-use ticket (preferred) or a raw JWT (fallback).
    Tickets are looked up in Redis and consumed (deleted) after use to
    prevent replay. If auth is disabled on the server, this is a no-op.
    """
    from config import settings as _cfg
    jwt_secret = _cfg.jwt_secret or _cfg.secret_token
    legacy_token = _cfg.secret_token

    if not jwt_secret and not legacy_token:
        return  # auth disabled

    if not token:
        raise WebSocketException(code=1008, reason="Authentication required")

    # Try ticket-based auth first (preferred path)
    from shared.redis_client import get_redis
    r = get_redis()
    if r:
        ticket_key = f"ws_ticket:{token}"
        ticket_data = r.get(ticket_key)
        if ticket_data:
            r.delete(ticket_key)  # single-use: consume immediately
            return  # ticket valid

    # Fallback: legacy single-token
    if legacy_token and token == legacy_token:
        return

    # Fallback: raw JWT (for clients that haven't migrated)
    try:
        import jwt as pyjwt
        pyjwt.decode(token, jwt_secret, algorithms=["HS256"])
    except Exception:
        raise WebSocketException(code=1008, reason="Invalid or expired token")
