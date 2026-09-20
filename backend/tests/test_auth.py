"""Tests for authentication, JWT tokens, and role-based access control."""

from database import User
from shared.auth import create_token, hash_password

# -- Login tests ---------------------------------------------------------------

def test_login_valid_credentials(client, db):
    """Login with valid credentials returns a JWT token."""
    user = User(
        username="admin1", email="a@test.com",
        hashed_pw=hash_password("SecurePass1"), role="admin", is_active=True,
    )
    db.add(user)
    db.commit()

    r = client.post("/api/auth/login", json={"username": "admin1", "password": "SecurePass1"})
    assert r.status_code == 200
    data = r.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert data["role"] == "admin"
    assert data["username"] == "admin1"


def test_login_invalid_password(client, db):
    """Login with wrong password returns 401."""
    user = User(
        username="admin2", email="b@test.com",
        hashed_pw=hash_password("CorrectPass1"), role="admin", is_active=True,
    )
    db.add(user)
    db.commit()

    r = client.post("/api/auth/login", json={"username": "admin2", "password": "WrongPass99"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_INVALID_CREDENTIALS"


def test_login_nonexistent_user(client):
    """Login with unknown username returns 401."""
    r = client.post("/api/auth/login", json={"username": "ghost", "password": "whatever1"})
    assert r.status_code == 401


def test_login_inactive_user(client, db):
    """Login with an inactive user returns 401."""
    user = User(
        username="inactive", email="i@test.com",
        hashed_pw=hash_password("InactivePass1"), role="admin", is_active=False,
    )
    db.add(user)
    db.commit()

    r = client.post("/api/auth/login", json={"username": "inactive", "password": "InactivePass1"})
    assert r.status_code == 401


# -- JWT authentication tests -------------------------------------------------

def test_jwt_token_authenticates_request(client, jwt_headers):
    """A valid JWT token grants access to protected endpoints."""
    r = client.get("/api/credentials", headers=jwt_headers)
    assert r.status_code == 200


def test_invalid_jwt_token_returns_401(client):
    """A malformed JWT token returns 401."""
    r = client.get("/api/credentials", headers={"Authorization": "Bearer bad.token.value"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_INVALID"


def test_missing_token_returns_401(client):
    """A request without any token returns 401."""
    r = client.get("/api/credentials")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_MISSING"


def test_expired_jwt_token_returns_401(client, db):
    """An expired JWT token returns 401."""
    from datetime import datetime, timedelta, timezone

    import jwt as pyjwt

    from shared.auth import JWT_ALGORITHM, JWT_SECRET

    user = User(
        username="exptest", email="e@test.com",
        hashed_pw=hash_password("ExpiredPass1"), role="admin", is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        "exp": datetime.now(timezone.utc) - timedelta(hours=1),
    }
    expired_token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    r = client.get("/api/credentials", headers={"Authorization": f"Bearer {expired_token}"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_EXPIRED"


# -- RBAC tests ----------------------------------------------------------------

def test_admin_can_create_user(client, jwt_headers):
    """Admin role can access the create-user endpoint."""
    r = client.post("/api/users", json={
        "username": "newuser", "password": "NewUserPass1", "role": "viewer",
    }, headers=jwt_headers)
    assert r.status_code == 201
    assert r.json()["username"] == "newuser"


def test_viewer_cannot_create_user(client, viewer_jwt_headers):
    """Viewer role is forbidden from creating users."""
    r = client.post("/api/users", json={
        "username": "hacker", "password": "HackerPass1", "role": "admin",
    }, headers=viewer_jwt_headers)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "AUTH_FORBIDDEN"


def test_admin_can_list_users(client, jwt_headers):
    """Admin role can list users."""
    r = client.get("/api/users", headers=jwt_headers)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_viewer_cannot_list_users(client, viewer_jwt_headers):
    """Viewer role is forbidden from listing users."""
    r = client.get("/api/users", headers=viewer_jwt_headers)
    assert r.status_code == 403


# -- get_current_user tests ----------------------------------------------------

def test_get_current_user_returns_jwt_info(client, db):
    """GET /api/auth/me returns the user info from the JWT token."""
    user = User(
        username="metest", email="me@test.com",
        hashed_pw=hash_password("MeTestPass1"), role="operator", is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_token(user.id, user.username, user.role)
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    data = r.json()
    assert data["username"] == "metest"
    assert data["role"] == "operator"
    assert data["id"] == user.id


# -- Password complexity tests ------------------------------------------------

def test_password_too_short_rejected(client, jwt_headers):
    """Creating a user with password shorter than 8 chars is rejected."""
    r = client.post("/api/users", json={
        "username": "shortpw", "password": "abc", "role": "viewer",
    }, headers=jwt_headers)
    assert r.status_code == 422


def test_password_minimum_length_accepted(client, jwt_headers):
    """Creating a user with exactly 8-char password succeeds."""
    r = client.post("/api/users", json={
        "username": "okpw", "password": "12345678", "role": "viewer",
    }, headers=jwt_headers)
    assert r.status_code == 201


# -- WebSocket ticket tests ----------------------------------------------------

def test_ws_ticket_requires_auth(client):
    """WS ticket endpoint requires authentication."""
    r = client.post("/api/auth/ws-ticket")
    assert r.status_code == 401


def test_ws_ticket_returns_ticket(client, jwt_headers):
    """WS ticket endpoint returns a ticket when authenticated (requires Redis mock)."""
    from unittest.mock import MagicMock, patch
    mock_redis = MagicMock()
    with patch("routers.auth.get_redis", return_value=mock_redis):
        r = client.post("/api/auth/ws-ticket", headers=jwt_headers)
    assert r.status_code == 200
    assert "ticket" in r.json()
    mock_redis.set.assert_called_once()


def test_ws_ticket_503_without_redis(client, jwt_headers):
    """WS ticket endpoint returns 503 when Redis is unavailable."""
    from unittest.mock import patch
    with patch("routers.auth.get_redis", return_value=None):
        r = client.post("/api/auth/ws-ticket", headers=jwt_headers)
    assert r.status_code == 503


# -- Token refresh tests -------------------------------------------------------

def test_refresh_with_valid_token(client, jwt_headers, db):
    """Refresh returns a new token when current token is valid."""
    r = client.post("/api/auth/refresh", headers=jwt_headers)
    assert r.status_code == 200
    data = r.json()
    assert "access_token" in data
    assert data["username"] == "testadmin"
    assert data["role"] == "admin"


def test_refresh_without_token(client):
    """Refresh returns 401 without a token."""
    r = client.post("/api/auth/refresh")
    assert r.status_code == 401


def test_refresh_with_inactive_user(client, db):
    """Refresh returns 401 if user is deactivated."""
    user = User(
        username="deactivated", email="d@test.com",
        hashed_pw=hash_password("TestPass123"), role="admin", is_active=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_token(user.id, user.username, user.role)
    r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


# -- Dry-run auth tests --------------------------------------------------------

def test_dry_run_requires_auth(client):
    """Dry-run endpoint now requires admin/operator role."""
    r = client.post("/api/scan/dry-run/jobs")
    assert r.status_code == 401


# -- Refresh revocation tests --------------------------------------------------

def _recently_expired_token(user):
    """Token expired 10 minutes ago: within the refresh window, but soft auth rejects it."""
    from datetime import datetime, timedelta, timezone

    import jwt as pyjwt

    from shared.auth import JWT_ALGORITHM, JWT_SECRET

    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        "jti": "test-jti",
        "iat": int((datetime.now(timezone.utc) - timedelta(hours=1)).timestamp()),
        "exp": datetime.now(timezone.utc) - timedelta(minutes=10),
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def test_refresh_rejects_blacklisted_token(client, db):
    """Refresh returns 401 when the token's JTI is blacklisted."""
    from unittest.mock import patch

    user = User(
        username="blrefresh", email="blr@test.com",
        hashed_pw=hash_password("TestPass123"), role="admin", is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = _recently_expired_token(user)
    with patch("routers.auth.is_token_blacklisted", return_value=True):
        r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_REVOKED"


def test_refresh_rejects_revoked_user(client, db):
    """Refresh returns 401 when all sessions of the user were revoked."""
    from unittest.mock import patch

    user = User(
        username="revrefresh", email="rev@test.com",
        hashed_pw=hash_password("TestPass123"), role="admin", is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = _recently_expired_token(user)
    with patch("routers.auth._is_user_revoked", return_value=True):
        r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_REVOKED"


def test_refresh_beyond_window_keeps_expired_code(client, db):
    """Refresh of a token expired beyond the window returns AUTH_EXPIRED, not AUTH_INVALID."""
    from datetime import datetime, timedelta, timezone

    import jwt as pyjwt

    from shared.auth import JWT_ALGORITHM, JWT_SECRET

    user = User(
        username="oldexp", email="old@test.com",
        hashed_pw=hash_password("TestPass123"), role="admin", is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        "iat": int((datetime.now(timezone.utc) - timedelta(hours=3)).timestamp()),
        "exp": datetime.now(timezone.utc) - timedelta(hours=2),
    }
    old_token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {old_token}"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_EXPIRED"


# -- create_user race condition test -------------------------------------------

def test_create_user_integrity_error_returns_409(client, jwt_headers, db, monkeypatch):
    """A unique-constraint race on username is mapped to 409, not a 500."""
    from sqlalchemy.exc import IntegrityError

    def failing_commit():
        raise IntegrityError("INSERT INTO users ...", {}, Exception("unique constraint"))

    monkeypatch.setattr(db, "commit", failing_commit)
    r = client.post("/api/users", json={
        "username": "raceuser", "password": "RacePass123", "role": "viewer",
    }, headers=jwt_headers)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "USER_EXISTS"


# -- Admin lockout guard tests --------------------------------------------------

def _get_user_id(db, username):
    return db.query(User).filter(User.username == username).first().id


def test_admin_cannot_deactivate_self(client, jwt_headers, db):
    """An admin cannot deactivate their own account."""
    admin_id = _get_user_id(db, "testadmin")
    r = client.put(f"/api/users/{admin_id}", json={"is_active": False}, headers=jwt_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "CANNOT_MODIFY_SELF"


def test_admin_cannot_demote_self(client, jwt_headers, db):
    """An admin cannot change their own role away from admin."""
    admin_id = _get_user_id(db, "testadmin")
    r = client.put(f"/api/users/{admin_id}", json={"role": "viewer"}, headers=jwt_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "CANNOT_MODIFY_SELF"


def test_admin_cannot_delete_self(client, jwt_headers, db):
    """An admin cannot delete their own account."""
    admin_id = _get_user_id(db, "testadmin")
    r = client.delete(f"/api/users/{admin_id}", headers=jwt_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "CANNOT_MODIFY_SELF"


def test_cannot_deactivate_last_active_admin(client, auth_headers, db):
    """Deactivating the last active admin is rejected (legacy-token caller)."""
    admin = User(
        username="onlyadmin", email="only@test.com",
        hashed_pw=hash_password("TestPass123"), role="admin", is_active=True,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    r = client.put(f"/api/users/{admin.id}", json={"is_active": False}, headers=auth_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "LAST_ADMIN"


def test_cannot_delete_last_active_admin(client, auth_headers, db):
    """Deleting the last active admin is rejected (legacy-token caller)."""
    admin = User(
        username="onlyadmin2", email="only2@test.com",
        hashed_pw=hash_password("TestPass123"), role="admin", is_active=True,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    r = client.delete(f"/api/users/{admin.id}", headers=auth_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "LAST_ADMIN"


def test_deactivate_admin_allowed_when_other_admin_active(client, auth_headers, db):
    """Deactivating an admin succeeds when another active admin exists."""
    for name in ("admin_a", "admin_b"):
        db.add(User(
            username=name, email=f"{name}@test.com",
            hashed_pw=hash_password("TestPass123"), role="admin", is_active=True,
        ))
    db.commit()
    target = _get_user_id(db, "admin_a")
    r = client.put(f"/api/users/{target}", json={"is_active": False}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["is_active"] is False
