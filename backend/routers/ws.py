"""WebSocket endpoint for real-time scan progress updates."""
import asyncio
import json
import logging
from typing import Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

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
    """Best-effort token validation for WebSocket connections.

    WebSockets cannot use standard HTTP auth headers, so the token is
    passed as a query parameter. If auth is disabled on the server,
    this is a no-op.
    """
    import os
    jwt_secret = os.getenv("JWT_SECRET", os.getenv("SECRET_TOKEN", ""))
    legacy_token = os.getenv("SECRET_TOKEN", "")

    if not jwt_secret and not legacy_token:
        return  # auth disabled

    if not token:
        return  # allow unauthenticated when no token provided (matches REST behavior)

    if legacy_token and token == legacy_token:
        return

    try:
        import jwt as pyjwt
        pyjwt.decode(token, jwt_secret, algorithms=["HS256"])
    except Exception:
        pass  # don't reject -- keep consistent with REST fallback behavior
