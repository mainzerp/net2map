"""WebSocket endpoint for real-time scan progress updates."""
import asyncio
import json
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import anyio
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect, WebSocketException

router = APIRouter()
_log = logging.getLogger(__name__)

AUTH_RECHECK_SECONDS = 5.0
AUTH_CHECK_TIMEOUT_SECONDS = 5.0


@dataclass
class _WsCredential:
    token: str
    recheck_at: float
    validation_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


# Credentials are resolved once so single-use tickets are never consumed again.
_clients: dict[WebSocket, _WsCredential] = {}
_clients_lock = asyncio.Lock()

# Event loop that owns the WebSocket connections (captured on first connect).
# ws.send_text must only ever be awaited on this loop.
_main_loop: Optional[asyncio.AbstractEventLoop] = None


async def broadcast_scan_update(data: dict) -> None:
    """Send a scan progress update to all connected WebSocket clients.

    The client set is snapshotted under the lock and sends happen outside it,
    so one slow/dead client cannot block connects, disconnects or other sends.
    """
    async with _clients_lock:
        clients = list(_clients)
    if not clients:
        return
    message = json.dumps(data, default=str)
    closed = []
    for ws in clients:
        try:
            if not await _validate_connection(ws):
                continue
            await ws.send_text(message)
        except WebSocketException as exc:
            # Remove before closing so concurrent broadcasts stop delivering data.
            async with _clients_lock:
                _clients.pop(ws, None)
            try:
                await ws.close(code=exc.code, reason=exc.reason)
            except Exception:
                pass
        except Exception:
            closed.append(ws)
    if closed:
        async with _clients_lock:
            for ws in closed:
                _clients.pop(ws, None)


async def _validate_connection(ws: WebSocket) -> bool:
    credential = _clients.get(ws)
    if credential is None:
        return False
    async with credential.validation_lock:
        if _clients.get(ws) is not credential:
            return False
        if time.monotonic() >= credential.recheck_at:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(_validate_ws_credential, credential.token),
                    timeout=AUTH_CHECK_TIMEOUT_SECONDS,
                )
            except TimeoutError as exc:
                raise WebSocketException(code=1011, reason="Authentication service unavailable") from exc
            # A broadcast may have closed this connection while the check ran.
            if _clients.get(ws) is not credential:
                return False
            credential.recheck_at = time.monotonic() + AUTH_RECHECK_SECONDS
        return True


async def _watch_auth(ws: WebSocket) -> None:
    """Revalidate idle connections independently of incoming message traffic."""
    while True:
        credential = _clients.get(ws)
        if credential is None:
            return
        # Broadcasts may advance the deadline; sleep to that exact deadline so
        # sharing their cached check cannot extend the revocation window.
        await asyncio.sleep(max(0, credential.recheck_at - time.monotonic()))
        if not await _validate_connection(ws):
            return


async def _drain_connection_tasks(*tasks: asyncio.Task) -> None:
    await asyncio.gather(*tasks, return_exceptions=True)


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
    while not loop.is_closed():
        try:
            r = get_redis()
            if not r:
                return
            pubsub = r.pubsub(ignore_subscribe_messages=True)
            try:
                pubsub.subscribe(SCAN_UPDATES_CHANNEL)
                while not loop.is_closed():
                    msg = pubsub.get_message(timeout=1.0)
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
    try:
        credential_token = await asyncio.wait_for(
            asyncio.to_thread(_authenticate_ws, token), timeout=AUTH_CHECK_TIMEOUT_SECONDS
        )
    except TimeoutError as exc:
        raise WebSocketException(code=1011, reason="Authentication service unavailable") from exc

    await ws.accept()
    _main_loop = asyncio.get_running_loop()
    _ensure_update_subscriber()
    async with _clients_lock:
        _clients[ws] = _WsCredential(credential_token, time.monotonic() + AUTH_RECHECK_SECONDS)

    _log.info("WebSocket client connected (%d total)", len(_clients))
    auth_task = asyncio.create_task(_watch_auth(ws))
    receive_task = asyncio.create_task(ws.receive_text())
    try:
        while True:
            done, _ = await asyncio.wait({auth_task, receive_task}, return_when=asyncio.FIRST_COMPLETED)
            if auth_task in done:
                auth_task.result()
                break
            receive_task.result()
            receive_task = asyncio.create_task(ws.receive_text())
    except WebSocketException as exc:
        async with _clients_lock:
            _clients.pop(ws, None)
        await ws.close(code=exc.code, reason=exc.reason)
    except WebSocketDisconnect:
        pass
    except Exception:
        await ws.close(code=1011, reason="Connection service unavailable")
    finally:
        # Remove synchronously before any cancellable cleanup await. A second
        # shutdown cancellation must never leave an authenticated broadcast entry.
        _clients.pop(ws, None)
        auth_task.cancel()
        receive_task.cancel()
        # Starlette cancels its AnyIO scope when peers disconnect; shield the
        # owned task drain so repeated scope cancellation cannot interrupt it.
        with anyio.CancelScope(shield=True):
            cleanup_task = asyncio.create_task(_drain_connection_tasks(auth_task, receive_task))
            while not cleanup_task.done():
                try:
                    await asyncio.shield(cleanup_task)
                except asyncio.CancelledError:
                    # Native asyncio cancellation bypasses AnyIO's shield.
                    # Keep draining the owned tasks before propagating shutdown.
                    continue
            cleanup_task.result()
        _log.info("WebSocket client disconnected (%d remaining)", len(_clients))


def _authenticate_ws(token: str) -> str:
    """Validate token for WebSocket connections.

    Accepts either a single-use ticket (preferred) or a raw JWT (fallback).
    Tickets are looked up in Redis and consumed atomically (GETDEL) after use
    to prevent replay. Raw JWTs go through the same blacklist / revocation
    checks as HTTP requests. If auth is disabled on the server, this is a
    no-op.
    """
    # Same module-level values as the HTTP path: the legacy SECRET_TOKEN is
    # only honored when JWT_SECRET is NOT configured (see shared.auth).
    from shared.auth import _LEGACY_TOKEN, JWT_SECRET

    if not JWT_SECRET and not _LEGACY_TOKEN:
        return ""  # auth disabled

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
            # Never replace atomic consumption with GET + DELETE: concurrent
            # connections could replay the same supposedly single-use ticket.
            raise WebSocketException(code=1011, reason="Authentication service unavailable")
        if ticket_data:
            try:
                token = json.loads(ticket_data)["token"]
            except (KeyError, TypeError, ValueError):
                raise WebSocketException(code=1008, reason="Invalid ticket")
            # Continue through the originating credential's expiry/revocation
            # checks: a ticket must not outlive the session that minted it.

    _validate_ws_credential(token)
    return token


def _validate_ws_credential(token: str) -> None:
    """Check the originating credential without consuming a WebSocket ticket."""
    from shared.auth import _LEGACY_TOKEN, JWT_SECRET

    if not JWT_SECRET and not _LEGACY_TOKEN:
        return

    # Legacy single-token -- empty unless JWT_SECRET is unset, so it is never
    # an accepted credential once JWT auth is configured.
    if _LEGACY_TOKEN and token == _LEGACY_TOKEN:
        return

    # Fallback: raw JWT (for clients that haven't migrated)
    try:
        import jwt as pyjwt

        from shared.auth import _is_user_revoked, is_token_blacklisted
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])

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
    except HTTPException as exc:
        if exc.status_code == 503:
            raise WebSocketException(code=1011, reason="Authentication service unavailable") from exc
        raise WebSocketException(code=1008, reason="Invalid or expired token") from exc
    except Exception:
        raise WebSocketException(code=1008, reason="Invalid or expired token")
