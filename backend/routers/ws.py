"""WebSocket endpoint for real-time scan progress updates."""
import asyncio
import json
import logging
import threading
import time
from typing import Optional, Set

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, WebSocketException

router = APIRouter()
_log = logging.getLogger(__name__)

# Active WebSocket connections
_clients: Set[WebSocket] = set()
_clients_lock = asyncio.Lock()

# Event loop that owns the WebSocket connections (captured on first connect).
# ws.send_text must only ever be awaited on this loop.
_main_loop: Optional[asyncio.AbstractEventLoop] = None


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

    Schedules the send on the event loop that owns the WebSocket connections
    (captured when the first client connects), never on a foreign loop.
    """
    loop = _main_loop
    if loop is None:
        return  # no client has ever connected in this process
    try:
        asyncio.run_coroutine_threadsafe(broadcast_scan_update(data), loop)
    except Exception:
        pass


# ── Redis pub/sub fan-in (multi-process delivery) ────────────────────────────

_subscriber_started = False
_subscriber_lock = threading.Lock()


def _ensure_update_subscriber() -> None:
    """Start the Redis pub/sub subscriber thread once, lazily.

    Scans running in a Celery worker publish updates to the scan-updates
    channel; this subscriber forwards them to the WebSocket clients of the
    local (web) process. Without Redis this is a no-op.
    """
    global _subscriber_started
    from shared.redis_client import get_redis
    if not get_redis():
        return
    with _subscriber_lock:
        if _subscriber_started:
            return
        _subscriber_started = True
    t = threading.Thread(target=_update_subscriber_thread, args=(_main_loop,), daemon=True)
    t.start()


def _update_subscriber_thread(loop: asyncio.AbstractEventLoop) -> None:
    """Forward Redis pub/sub scan updates to the local WebSocket clients."""
    from scan_engine.broadcast import SCAN_UPDATES_CHANNEL
    from shared.redis_client import get_redis
    while True:
        try:
            r = get_redis()
            if not r:
                return
            pubsub = r.pubsub(ignore_subscribe_messages=True)
            try:
                pubsub.subscribe(SCAN_UPDATES_CHANNEL)
                for msg in pubsub.listen():
                    if not msg or msg.get("type") != "message":
                        continue
                    try:
                        payload = json.loads(msg["data"])
                    except Exception:
                        continue
                    # Deliver on the loop that owns the connections
                    asyncio.run_coroutine_threadsafe(broadcast_scan_update(payload), loop)
            finally:
                try:
                    pubsub.close()
                except Exception:
                    pass
        except Exception as exc:
            _log.warning("scan-update subscriber error: %s", exc)
            time.sleep(2)


@router.websocket("/ws/scan-progress")
async def scan_progress_ws(ws: WebSocket, token: str = Query(default="")):
    global _main_loop

    # Validate token if auth is enabled
    _authenticate_ws(token)

    await ws.accept()
    _main_loop = asyncio.get_running_loop()
    _ensure_update_subscriber()
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
    Tickets are looked up in Redis and consumed atomically (GETDEL) after use
    to prevent replay. Raw JWTs go through the same blacklist / revocation
    checks as HTTP requests. If auth is disabled on the server, this is a
    no-op.
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
        try:
            # Atomic single-use consume (GETDEL, Redis >= 6.2)
            ticket_data = r.getdel(ticket_key)
        except Exception:
            # Fallback for servers without GETDEL support
            ticket_data = r.get(ticket_key)
            if ticket_data:
                r.delete(ticket_key)
        if ticket_data:
            return  # ticket valid

    # Fallback: legacy single-token
    if legacy_token and token == legacy_token:
        return

    # Fallback: raw JWT (for clients that haven't migrated)
    try:
        import jwt as pyjwt

        from shared.auth import _is_user_revoked, is_token_blacklisted
        payload = pyjwt.decode(token, jwt_secret, algorithms=["HS256"])

        # Same revocation checks as the HTTP auth path
        jti = payload.get("jti")
        if jti and is_token_blacklisted(jti):
            raise WebSocketException(code=1008, reason="Token has been revoked")
        try:
            user_id = int(payload.get("sub", 0) or 0)
        except (TypeError, ValueError):
            user_id = 0
        if user_id and _is_user_revoked(user_id, payload.get("iat", 0)):
            raise WebSocketException(code=1008, reason="All sessions have been revoked")
    except WebSocketException:
        raise
    except Exception:
        raise WebSocketException(code=1008, reason="Invalid or expired token")
