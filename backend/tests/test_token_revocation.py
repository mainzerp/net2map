"""Tests for token revocation: logout, revoke-all, blacklisted token rejection."""
from unittest.mock import patch

from database import User
from shared.auth import create_token, hash_password


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
