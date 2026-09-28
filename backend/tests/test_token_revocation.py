"""Tests for token revocation: logout, revoke-all, blacklisted token rejection."""
import time
from unittest.mock import patch

import jwt as pyjwt

from database import User
from shared.auth import JWT_SECRET, create_token, hash_password


class FakeRedis:
    """Minimal in-memory Redis stand-in for token revocation keys."""

    def __init__(self):
        self._store = {}

    def set(self, key, value, ex=None, nx=False, **kwargs):
        if nx and key in self._store:
            return None
        self._store[key] = value
        return True

    def get(self, key):
        return self._store.get(key)

    def getdel(self, key):
        return self._store.pop(key, None)

    def delete(self, key):
        self._store.pop(key, None)

    def exists(self, key):
        return 1 if key in self._store else 0


def _make_user(db, username, role="viewer", is_active=True):
    user = User(
        username=username, email="",
        hashed_pw=hash_password("Pass1234"), role=role, is_active=is_active,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_logout_endpoint_returns_ok(client, jwt_headers):
    """POST /api/auth/logout returns ok status."""
    r = client.post("/api/auth/logout", headers=jwt_headers)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_logout_without_token_returns_401(client):
    """POST /api/auth/logout without auth header returns 401."""
    r = client.post("/api/auth/logout")
    assert r.status_code == 401


def test_logout_blacklists_token(client, db):
    """Logout calls blacklist_token for the JWT's JTI."""
    user = User(
        username="logouttest", email="lo@test.com",
        hashed_pw=hash_password("Pass1234"), role="admin", is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_token(user.id, user.username, user.role)
    headers = {"Authorization": f"Bearer {token}"}

    with patch("routers.auth.blacklist_token") as mock_bl:
        r = client.post("/api/auth/logout", headers=headers)
        assert r.status_code == 200
        mock_bl.assert_called_once()
        # First arg should be the JTI string
        jti_arg = mock_bl.call_args[0][0]
        assert isinstance(jti_arg, str)
        assert len(jti_arg) > 0


def test_revoke_all_endpoint(client, jwt_headers):
    """POST /api/auth/revoke-all calls blacklist_all_user_tokens."""
    with patch("routers.auth.blacklist_all_user_tokens") as mock_revoke:
        r = client.post("/api/auth/revoke-all", headers=jwt_headers)
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        mock_revoke.assert_called_once()


def test_revoke_all_requires_admin(client, viewer_jwt_headers):
    """Viewer role cannot call revoke-all."""
    r = client.post("/api/auth/revoke-all", headers=viewer_jwt_headers)
    assert r.status_code == 403


def test_update_user_role_change_revokes_sessions(client, db, jwt_headers):
    """Changing a user's role revokes all of that user's existing tokens."""
    fake = FakeRedis()
    user = _make_user(db, "rolechange", role="viewer")
    user_headers = {"Authorization": f"Bearer {create_token(user.id, user.username, user.role)}"}

    with patch("shared.redis_client.get_redis", return_value=fake):
        r = client.put(f"/api/users/{user.id}", json={"role": "operator"}, headers=jwt_headers)
        assert r.status_code == 200
        assert f"token_revoke_all:{user.id}" in fake._store

        r = client.get("/api/auth/me", headers=user_headers)
        assert r.status_code == 401


def test_update_user_deactivate_revokes_sessions(client, db, jwt_headers):
    """Deactivating a user (is_active=False) revokes their sessions."""
    fake = FakeRedis()
    user = _make_user(db, "deactivateme", role="operator")
    user_headers = {"Authorization": f"Bearer {create_token(user.id, user.username, user.role)}"}

    with patch("shared.redis_client.get_redis", return_value=fake):
        r = client.put(f"/api/users/{user.id}", json={"is_active": False}, headers=jwt_headers)
        assert r.status_code == 200
        r = client.get("/api/auth/me", headers=user_headers)
        assert r.status_code == 401


def test_delete_user_revokes_sessions(client, db, jwt_headers):
    """Deleting a user revokes all of that user's existing tokens."""
    fake = FakeRedis()
    user = _make_user(db, "deleteme", role="viewer")
    user_headers = {"Authorization": f"Bearer {create_token(user.id, user.username, user.role)}"}

    with patch("shared.redis_client.get_redis", return_value=fake):
        r = client.delete(f"/api/users/{user.id}", headers=jwt_headers)
        assert r.status_code == 204
        assert f"token_revoke_all:{user.id}" in fake._store

        r = client.get("/api/auth/me", headers=user_headers)
        assert r.status_code == 401


def test_refresh_beyond_grace_fails(client, db):
    """A token expired more than REFRESH_GRACE_SECONDS ago cannot be refreshed."""
    user = _make_user(db, "staletoken", role="viewer")
    now = int(time.time())
    expired_token = pyjwt.encode(
        {
            "sub": str(user.id),
            "username": user.username,
            "role": user.role,
            "jti": "stale-jti",
            "iat": now - 7200,
            "exp": now - 3700,  # expired just over the 3600s grace window
        },
        JWT_SECRET,
        algorithm="HS256",
    )
    r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {expired_token}"})
    assert r.status_code == 401


def test_blacklisted_token_cannot_refresh(client, db, jwt_headers):
    """A logged-out (blacklisted) token cannot be refreshed within the grace window."""
    fake = FakeRedis()
    with patch("shared.redis_client.get_redis", return_value=fake):
        r = client.post("/api/auth/logout", headers=jwt_headers)
        assert r.status_code == 200
        r = client.post("/api/auth/refresh", headers=jwt_headers)
        assert r.status_code == 401
