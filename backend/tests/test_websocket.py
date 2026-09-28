"""Tests for WebSocket scan-progress endpoint and auth helpers."""
from unittest.mock import MagicMock, patch

import pytest
from fastapi import WebSocketException

from routers.ws import _authenticate_ws

# ---------------------------------------------------------------------------
# T3c: WebSocket Tests (7 tests)
# ---------------------------------------------------------------------------

def _patch_cfg(jwt_secret="", secret_token=""):
    """Patch the shared.auth module constants for a (jwt_secret, secret_token) pair.

    Mirrors shared.auth semantics: JWT_SECRET falls back to SECRET_TOKEN, and
    the legacy token is only honored when JWT_SECRET is unset.
    """
    return patch.multiple(
        "shared.auth",
        JWT_SECRET=jwt_secret or secret_token,
        _LEGACY_TOKEN="" if jwt_secret else secret_token,
    )


class TestAuthenticateWs:
    """Unit tests for _authenticate_ws() helper."""

    def test_no_auth_configured_allows_empty_token(self):
        """When both jwt_secret and secret_token are empty, auth is disabled."""
        with _patch_cfg(jwt_secret="", secret_token=""):
            _authenticate_ws("")

    def test_empty_token_raises_when_auth_enabled(self):
        """When auth is configured, empty token must be rejected."""
        with _patch_cfg(jwt_secret="secret", secret_token="tok123"):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws("")
            assert exc.value.code == 1008

    def test_legacy_token_accepted(self):
        """The legacy single-token auth should be accepted."""
        with _patch_cfg(jwt_secret="", secret_token="my-legacy-token"), \
             patch("shared.redis_client.get_redis", return_value=None):
            _authenticate_ws("my-legacy-token")

    def test_legacy_token_rejected_when_jwt_secret_set(self):
        """With JWT_SECRET configured, the legacy SECRET_TOKEN is not accepted."""
        with _patch_cfg(jwt_secret="jwt-secret", secret_token="legacy-tok"), \
             patch("shared.redis_client.get_redis", return_value=None):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws("legacy-tok")
            assert exc.value.code == 1008

    def test_invalid_token_raises(self):
        """A completely invalid token should raise WebSocketException."""
        with _patch_cfg(jwt_secret="secret", secret_token="tok123"), \
             patch("shared.redis_client.get_redis", return_value=None):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws("bad-token")
            assert exc.value.code == 1008

    def test_ticket_based_auth_accepted(self):
        """A valid Redis-backed ticket should be consumed atomically (GETDEL)."""
        mock_redis = MagicMock()
        mock_redis.getdel.return_value = '{"user_id": 1}'
        with _patch_cfg(jwt_secret="secret", secret_token=""), \
             patch("shared.redis_client.get_redis", return_value=mock_redis):
            _authenticate_ws("valid-ticket-token")
        mock_redis.getdel.assert_called_once_with("ws_ticket:valid-ticket-token")

    def test_jwt_fallback_accepted(self):
        """A valid JWT token should be accepted when ticket lookup misses."""
        import jwt as pyjwt
        secret = "test-jwt-secret"
        token = pyjwt.encode({"sub": "1", "username": "u"}, secret, algorithm="HS256")
        mock_redis = MagicMock()
        mock_redis.getdel.return_value = None
        mock_redis.get.return_value = None  # no revocation markers
        with _patch_cfg(jwt_secret=secret, secret_token=""), \
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
        with _patch_cfg(jwt_secret=secret, secret_token=""), \
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
        with _patch_cfg(jwt_secret=secret, secret_token=""), \
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
        with _patch_cfg(jwt_secret=secret, secret_token=""), \
             patch("shared.redis_client.get_redis", return_value=mock_redis):
            with pytest.raises(WebSocketException) as exc:
                _authenticate_ws(token)
            assert exc.value.code == 1008
