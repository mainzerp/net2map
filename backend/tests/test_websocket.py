"""Tests for WebSocket scan-progress endpoint and auth helpers."""
import asyncio
import json
import threading
import time
from contextlib import nullcontext
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import WebSocketException

from database import User
from routers.ws import _authenticate_ws
from shared.auth import DUMMY_PASSWORD_HASH, create_token


@pytest.fixture(autouse=True)
def _ws_user(db):
    """User id 1: tokens of missing users count as revoked (DB-backed revocation)."""
    db.add(User(id=1, username="ws-user", email="", hashed_pw=DUMMY_PASSWORD_HASH, role="viewer", is_active=True))
    db.commit()

# ---------------------------------------------------------------------------
# T3c: WebSocket Tests (7 tests)
# ---------------------------------------------------------------------------

def _patch_cfg(jwt_secret="test-jwt-secret"):
    """Patch the JWT signing key used by shared.auth."""
    return patch("shared.auth.JWT_SECRET", jwt_secret)


class TestAuthenticateWs:
    """Unit tests for _authenticate_ws() helper."""

    def test_empty_token_raises(self):
        """An empty token must be rejected."""
        with _patch_cfg(jwt_secret="secret"):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws("")
            assert exc.value.code == 1008

    def test_invalid_token_raises(self):
        """A completely invalid token should raise WebSocketException."""
        with _patch_cfg(jwt_secret="secret"), \
             patch("shared.redis_client.get_redis", return_value=None):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws("bad-token")
            assert exc.value.code == 1008

    def test_raw_jwt_secret_as_token_rejected(self):
        """A static non-JWT bearer value (even the signing key itself) is never a credential."""
        with _patch_cfg(jwt_secret="jwt-secret"), \
             patch("shared.redis_client.get_redis", return_value=None):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws("jwt-secret")
            assert exc.value.code == 1008

    def test_ticket_based_auth_accepted(self):
        """A valid Redis-backed ticket should be consumed atomically (GETDEL)."""
        mock_redis = MagicMock()
        mock_redis.getdel.return_value = json.dumps({"token": create_token(1, "ws-user", "viewer")})
        mock_redis.exists.return_value = 0
        mock_redis.get.return_value = None
        with patch("shared.redis_client.get_redis", return_value=mock_redis):
            _authenticate_ws("valid-ticket-token")
        mock_redis.getdel.assert_called_once_with("ws_ticket:valid-ticket-token")

    def test_ticket_consumption_failure_never_uses_non_atomic_fallback(self):
        mock_redis = MagicMock()
        mock_redis.getdel.side_effect = ConnectionError("Redis unavailable")
        mock_redis.get.return_value = '{"id": 1}'
        with _patch_cfg(jwt_secret="secret"), \
                patch("shared.redis_client.get_redis", return_value=mock_redis):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws("single-use-ticket")
        assert exc.value.code == 1011
        mock_redis.get.assert_not_called()
        mock_redis.delete.assert_not_called()

    def test_jwt_fallback_accepted(self):
        """A valid JWT token should be accepted when ticket lookup misses."""
        import jwt as pyjwt
        secret = "test-jwt-secret"
        token = pyjwt.encode({"sub": "1", "username": "u"}, secret, algorithm="HS256")
        mock_redis = MagicMock()
        mock_redis.getdel.return_value = None
        mock_redis.get.return_value = None  # no revocation markers
        with _patch_cfg(jwt_secret=secret), \
             patch("shared.redis_client.get_redis", return_value=mock_redis):
            _authenticate_ws(token)

    def test_jwt_expired_raises(self):
        """An expired JWT should be rejected."""
        import time

        import jwt as pyjwt
        secret = "test-jwt-secret"
        token = pyjwt.encode(
            {"sub": 1, "exp": int(time.time()) - 3600}, secret, algorithm="HS256"
        )
        mock_redis = MagicMock()
        mock_redis.getdel.return_value = None
        with _patch_cfg(jwt_secret=secret), \
             patch("shared.redis_client.get_redis", return_value=mock_redis):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws(token)
            assert exc.value.code == 1008

    def test_jwt_blacklisted_raises(self):
        """A JWT whose jti is blacklisted must be rejected."""
        import jwt as pyjwt
        secret = "test-jwt-secret"
        token = pyjwt.encode(
            {"sub": "1", "username": "u", "jti": "abc123"}, secret, algorithm="HS256"
        )
        mock_redis = MagicMock()
        mock_redis.getdel.return_value = None
        mock_redis.exists.return_value = 1  # jti blacklisted
        with _patch_cfg(jwt_secret=secret), \
             patch("shared.redis_client.get_redis", return_value=mock_redis):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws(token)
            assert exc.value.code == 1008

    def test_jwt_revoked_user_raises(self):
        """A JWT issued before a user-level revoke_all must be rejected."""
        import time

        import jwt as pyjwt
        secret = "test-jwt-secret"
        now = int(time.time())
        token = pyjwt.encode(
            {"sub": "1", "username": "u", "iat": now - 100}, secret, algorithm="HS256"
        )
        mock_redis = MagicMock()
        mock_redis.getdel.return_value = None
        mock_redis.exists.return_value = 0
        mock_redis.get.return_value = str(now)  # revoke_all marker after iat
        with _patch_cfg(jwt_secret=secret), \
             patch("shared.redis_client.get_redis", return_value=mock_redis):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws(token)
            assert exc.value.code == 1008


def test_websocket_route_accepts_ticket_with_global_auth_dependency(client):
    mock_redis = MagicMock()
    mock_redis.getdel.return_value = json.dumps({"token": create_token(1, "ws-user", "viewer")})
    mock_redis.exists.return_value = 0
    mock_redis.get.return_value = None
    with patch("shared.redis_client.get_redis", return_value=mock_redis), \
            patch("routers.ws._ensure_update_subscriber"):
        with client.websocket_connect("/ws/scan-progress?token=single-use-ticket") as websocket:
            websocket.send_text("ping")


def test_websocket_route_rejects_missing_auth(client):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/scan-progress"):
            pass
    assert exc.value.code == 1008


@pytest.mark.parametrize("failure", ["token_revoked", "user_revoked", "redis_outage", "expired"])
def test_connected_ticket_session_is_revalidated_while_idle(client, failure):
    import jwt
    from starlette.websockets import WebSocketDisconnect

    from routers import ws as ws_module

    secret = "websocket-revalidation-test-secret"
    now = int(time.time())
    token = jwt.encode({"sub": "1", "jti": "connected-jti", "iat": now - 10, "exp": now + 60}, secret)
    redis = MagicMock()
    redis.getdel.return_value = json.dumps({"token": token})
    redis.exists.return_value = 0
    redis.get.return_value = None
    with _patch_cfg(jwt_secret=secret), patch("shared.redis_client.get_redis", return_value=redis), \
            patch("routers.ws._ensure_update_subscriber"), patch("routers.ws.AUTH_RECHECK_SECONDS", 0.01):
        with client.websocket_connect("/ws/scan-progress?token=single-use-ticket") as websocket:
            if failure == "token_revoked":
                redis.exists.return_value = 1
            elif failure == "user_revoked":
                redis.get.return_value = str(now)
            elif failure == "redis_outage":
                redis.exists.side_effect = ConnectionError("Redis unavailable")
            expiry_patch = patch("jwt.decode", side_effect=jwt.ExpiredSignatureError())
            with expiry_patch if failure == "expired" else nullcontext():
                with pytest.raises(WebSocketDisconnect) as exc:
                    websocket.receive_text()
                assert exc.value.code == (1011 if failure == "redis_outage" else 1008)
        redis.getdel.assert_called_once_with("ws_ticket:single-use-ticket")
        assert not ws_module._clients


@pytest.mark.parametrize("unexpected_error", [False, True])
def test_busy_connection_cannot_delay_revalidation_and_cleans_receive_task(unexpected_error):
    from routers import ws as ws_module

    async def exercise():
        socket = MagicMock()
        socket.accept = AsyncMock()
        socket.close = AsyncMock()
        messages = 0

        async def receive():
            nonlocal messages
            messages += 1
            await asyncio.sleep(0)
            return "ping"

        socket.receive_text = receive
        error = RuntimeError("Authentication monitor failed") if unexpected_error else WebSocketException(code=1008)
        with patch("routers.ws._authenticate_ws", return_value="originating-token"), \
                patch("routers.ws._validate_ws_credential", side_effect=error), \
                patch("routers.ws._ensure_update_subscriber"), patch("routers.ws.AUTH_RECHECK_SECONDS", 0.01):
            await asyncio.wait_for(ws_module.scan_progress_ws(socket, token="ticket"), timeout=1)
        socket.close.assert_awaited_once_with(
            code=1011 if unexpected_error else 1008,
            reason="Connection service unavailable" if unexpected_error else "",
        )
        assert messages > 1
        assert socket not in ws_module._clients
        assert len(asyncio.all_tasks()) == 1

    asyncio.run(exercise())


def test_broadcast_revalidates_before_delivering_and_throttles_redis_checks():
    from routers import ws as ws_module

    async def exercise():
        socket = MagicMock()
        socket.send_text = AsyncMock()
        socket.close = AsyncMock()
        ws_module._clients[socket] = ws_module._WsCredential("originating-token", 10)
        try:
            with patch("routers.ws.time.monotonic", return_value=10), \
                    patch("routers.ws._validate_ws_credential") as validate:
                await ws_module.broadcast_scan_update({"progress": 1})
                await ws_module.broadcast_scan_update({"progress": 2})
                validate.assert_called_once_with("originating-token")
                assert socket.send_text.await_count == 2
            with patch("routers.ws.time.monotonic", return_value=20), patch(
                "routers.ws._validate_ws_credential", side_effect=WebSocketException(code=1008, reason="Revoked")
            ):
                await ws_module.broadcast_scan_update({"progress": 3})
                await ws_module.broadcast_scan_update({"progress": 4})
            assert socket.send_text.await_count == 2
            socket.close.assert_awaited_once_with(code=1008, reason="Revoked")
            assert socket not in ws_module._clients
        finally:
            ws_module._clients.pop(socket, None)

    asyncio.run(exercise())


def test_hung_revalidation_times_out_without_blocking_other_event_loop_work():
    from routers import ws as ws_module

    async def exercise():
        socket = MagicMock()
        release = threading.Event()
        ticks = []
        ws_module._clients[socket] = ws_module._WsCredential("originating-token", 0)

        def stalled_validation(token):
            release.wait(timeout=1)

        async def other_client_work():
            await asyncio.sleep(0.005)
            ticks.append("responsive")

        try:
            with patch("routers.ws._validate_ws_credential", side_effect=stalled_validation), \
                    patch("routers.ws.AUTH_CHECK_TIMEOUT_SECONDS", 0.02):
                ticker = asyncio.create_task(other_client_work())
                with pytest.raises(WebSocketException) as exc:
                    await ws_module._validate_connection(socket)
                assert exc.value.code == 1011
                assert ticks == ["responsive"]
                assert ws_module._clients[socket].recheck_at == 0
                await ticker
        finally:
            release.set()
            ws_module._clients.pop(socket, None)

    asyncio.run(exercise())


def test_repeated_native_cancellation_drains_owned_tasks_and_removes_connection():
    from routers import ws as ws_module

    async def exercise():
        socket = MagicMock()
        socket.accept = AsyncMock()
        socket.close = AsyncMock()
        receiving = asyncio.Event()
        cleanup_started = asyncio.Event()
        cleanup_release = asyncio.Event()
        finished = asyncio.Event()

        async def receive():
            receiving.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleanup_started.set()
                await cleanup_release.wait()
                finished.set()

        socket.receive_text = receive
        with patch("routers.ws._authenticate_ws", return_value="originating-token"), \
                patch("routers.ws._ensure_update_subscriber"):
            route = asyncio.create_task(ws_module.scan_progress_ws(socket, token="ticket"))
            await receiving.wait()
            route.cancel()
            await cleanup_started.wait()
            assert socket not in ws_module._clients
            route.cancel()
            await asyncio.sleep(0)
            assert not route.done()
            cleanup_release.set()
            with pytest.raises(asyncio.CancelledError):
                await route
        assert finished.is_set()
        assert len(asyncio.all_tasks()) == 1

    asyncio.run(exercise())


def test_pubsub_subscriber_exits_when_its_event_loop_closes():
    from routers import ws as ws_module

    loop = asyncio.new_event_loop()
    loop.close()
    with patch.dict("sys.modules", {"scan_engine.broadcast": MagicMock()}), \
            patch("shared.redis_client.get_redis") as get_redis:
        ws_module._update_subscriber_thread(loop)
    get_redis.assert_not_called()
