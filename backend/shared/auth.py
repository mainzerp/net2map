"""Authentication: JWT tokens, bcrypt passwords, role-based guards."""
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.requests import HTTPConnection

from config import settings
from database import get_db
from shared.api_version import api_relative_path

_log = logging.getLogger(__name__)

JWT_SECRET = settings.jwt_secret
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = settings.jwt_expiry_hours

# How long past `exp` a token may still be refreshed (see /api/v1/auth/refresh).
# Blacklist/revocation entries must outlive this window, otherwise a revoked
# token could still be exchanged for a fresh one during the grace period.
REFRESH_GRACE_SECONDS = 3600

# Absolute session lifetime enforced by /auth/refresh via the auth_time claim.
MAX_SESSION_SECONDS = settings.jwt_max_session_hours * 3600

# bcrypt only uses the first 72 bytes of a password (bcrypt >= 4.1 rejects
# longer input with ValueError).
BCRYPT_MAX_PASSWORD_BYTES = 72

# Per-process cache of users.token_epoch (DB-backed revocation, migration
# 029). A revocation in another process takes effect here within this bound;
# revocations in this process invalidate the entry immediately.
EPOCH_CACHE_TTL_SECONDS = 5.0

# Precomputed bcrypt hash used for dummy verification on login attempts with
# unknown usernames, so response timing does not reveal whether a user exists.
DUMMY_PASSWORD_HASH = "$2b$12$43/hneyCbrcdSGlerxj3M.rM1tEO9kzfsp4NT2v2eRpmA3GmFoowa"

class _HttpOnlyBearer(HTTPBearer):
    async def __call__(self, request: HTTPConnection):
        if request.scope["type"] == "websocket":
            return None
        return await super().__call__(request)


_bearer = _HttpOnlyBearer(auto_error=False)

# Non-API paths exempt from authentication (matched verbatim).
_AUTH_EXEMPT_PATHS = {"/health"}
# API paths exempt from authentication, relative to the version prefix so that
# every mount ("/api/v1/...", the legacy "/api/..." alias, future versions)
# shares one list.
_AUTH_EXEMPT_API_PATHS = {"/auth/login", "/map-background", "/auth/refresh", "/auth/logout"}
# Version-relative path patterns exempt from authentication for GET only
# (per-floor background images are loaded via <img> without a token).
_AUTH_EXEMPT_API_GET_PATTERNS = (re.compile(r"/floors/\d+/background"),)


def _is_auth_exempt(path: str, method: str | None = None) -> bool:
    if path in _AUTH_EXEMPT_PATHS:
        return True
    rel = api_relative_path(path)
    if rel is None:
        return False
    if rel in _AUTH_EXEMPT_API_PATHS:
        return True
    return method == "GET" and any(p.fullmatch(rel) for p in _AUTH_EXEMPT_API_GET_PATTERNS)


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def create_token(user_id: int, username: str, role: str, auth_time: int | None = None) -> str:
    """Issue a JWT.

    ``auth_time`` is the unix time of the original login; refreshes carry it
    over unchanged (default: now, i.e. a fresh login). ``iat_ms`` gives the
    DB-backed revocation check millisecond precision.
    """
    jti = str(uuid.uuid4())
    iat_ms = _now_ms()
    iat = iat_ms // 1000
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "jti": jti,
        "iat": iat,
        "iat_ms": iat_ms,
        "auth_time": iat if auth_time is None else int(auth_time),
        "exp": datetime.fromtimestamp(iat, tz=timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def password_too_long(password: str) -> bool:
    return len(password.encode()) > BCRYPT_MAX_PASSWORD_BYTES


def hash_password(password: str) -> str:
    if password_too_long(password):
        raise ValueError(f"Password must not exceed {BCRYPT_MAX_PASSWORD_BYTES} bytes")
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    if password_too_long(password):
        # Never stored (hash_password rejects it), so it cannot match. Still
        # spend one bcrypt round so timing matches a wrong password.
        bcrypt.checkpw(b"", DUMMY_PASSWORD_HASH.encode())
        return False
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def blacklist_token(jti: str, remaining_seconds: int) -> bool:
    """Add a JTI to the Redis blacklist. Returns True if blacklisted successfully."""
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        return False
    try:
        r.set(
            f"token_blacklist:{jti}", "1",
            # TTL must cover the refresh grace window so a logged-out token
            # cannot be refreshed after its blacklist entry expired.
            ex=max(1, remaining_seconds) + REFRESH_GRACE_SECONDS,
        )
        return True
    except Exception:
        _log.warning("Failed to blacklist token jti=%s", jti)
        return False


def is_token_blacklisted(jti: str) -> bool:
    """Check if a JTI is blacklisted."""
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        if settings.redis_url:
            _revocation_unavailable()
        return False
    try:
        return r.exists(f"token_blacklist:{jti}") > 0
    except Exception:
        _revocation_unavailable()


def _revocation_unavailable():
    raise HTTPException(
        status_code=503,
        detail={"error": {"code": "AUTH_UNAVAILABLE", "message": "Session revocation service unavailable"}},
    )


# user_id -> (cache expiry on the monotonic clock, revoked_before_ms or None
# when the user does not exist or is inactive)
_revocation_cache: dict[int, tuple[float, int | None]] = {}
_revocation_cache_lock = threading.Lock()


def clear_revocation_cache(user_id: int | None = None) -> None:
    """Drop cached revocation state (one user, or all users)."""
    with _revocation_cache_lock:
        if user_id is None:
            _revocation_cache.clear()
        else:
            _revocation_cache.pop(user_id, None)


def _load_revoked_before_ms(user_id: int, db: Session | None) -> int | None:
    import database
    from database import User

    own_session = db is None
    if own_session:
        db = database.SessionLocal()
    try:
        row = db.query(User.revoked_before_ms, User.is_active).filter(User.id == user_id).first()
    finally:
        if own_session:
            db.close()
    if row is None or not row.is_active:
        return None
    return int(row.revoked_before_ms or 0)


def get_revoked_before_ms(user_id: int, db: Session | None = None) -> int | None:
    """The user's revocation instant (cached for EPOCH_CACHE_TTL_SECONDS).

    Returns None for a missing or inactive user: every token of such a user
    counts as revoked. Raises 503 when the database cannot be read.
    """
    now = time.monotonic()
    with _revocation_cache_lock:
        cached = _revocation_cache.get(user_id)
    if cached and cached[0] > now:
        return cached[1]
    try:
        value = _load_revoked_before_ms(user_id, db)
    except SQLAlchemyError:
        _log.exception("Failed to read session revocation state for user %s", user_id)
        _revocation_unavailable()
    with _revocation_cache_lock:
        _revocation_cache[user_id] = (now + EPOCH_CACHE_TTL_SECONDS, value)
    return value


def mark_user_tokens_revoked(db: Session, user_id: int) -> bool:
    """Revoke every token of ``user_id`` in the caller's transaction (no commit).

    Sets users.revoked_before_ms to now (never moving it backwards). Returns
    False when the user row does not exist. The caller must commit and then
    call ``user_tokens_revoked_committed`` to propagate the change.
    """
    from database import User

    now_ms = _now_ms()
    row = db.query(User.revoked_before_ms).filter(User.id == user_id).first()
    if row is None:
        return False
    current = row[0]
    db.query(User).filter(User.id == user_id).update(
        {User.revoked_before_ms: max(now_ms, int(current or 0) + 1)}, synchronize_session="fetch",
    )
    return True


def user_tokens_revoked_committed(user_id: int) -> None:
    """After the revocation commit: drop the local cache entry and mirror to Redis.

    The Redis key (best effort) keeps processes of older versions, which only
    know the Redis-based revocation, in sync during a rolling upgrade.
    """
    clear_revocation_cache(user_id)
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        return
    try:
        r.set(
            f"token_revoke_all:{user_id}",
            str(int(datetime.now(timezone.utc).timestamp())),
            ex=JWT_EXPIRY_HOURS * 3600 + REFRESH_GRACE_SECONDS,
        )
    except Exception:
        _log.warning("Failed to mirror session revocation of user %s to Redis", user_id)


def blacklist_all_user_tokens(user_id: int, db: Session | None = None) -> bool:
    """Revoke all tokens of a user and commit. Returns False if the user does not exist.

    Uses the given session (committing it) or a short-lived own session.
    Database errors propagate.
    """
    import database

    own_session = db is None
    if own_session:
        db = database.SessionLocal()
    try:
        if not mark_user_tokens_revoked(db, user_id):
            return False
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        if own_session:
            db.close()
    user_tokens_revoked_committed(user_id)
    return True


def _legacy_redis_revoked(user_id: int, token_iat: int) -> bool:
    """Redis revoke-all key written by versions before migration 029.

    Only consulted for tokens without an ``iat_ms`` claim (issued by those
    versions); newer tokens are covered by the database check alone.
    """
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        if settings.redis_url:
            _revocation_unavailable()
        return False
    try:
        revoked_at = r.get(f"token_revoke_all:{user_id}")
    except Exception:
        _revocation_unavailable()
    # <= is intentional: iat has 1-second granularity, so a token issued in
    # the SAME second as the revocation must also count as revoked.
    return bool(revoked_at) and token_iat <= int(revoked_at)


def _is_user_revoked(user_id: int, token_iat: int, token_iat_ms: int | None = None,
                     db: Session | None = None) -> bool:
    """True when the user is gone/inactive or revoked all sessions after this token was issued.

    ``token_iat_ms`` (the ``iat_ms`` claim) enables a millisecond comparison;
    without it the 1-second ``iat`` is used and a token issued in the same
    second as the revocation counts as revoked.
    """
    revoked_before_ms = get_revoked_before_ms(user_id, db)
    if revoked_before_ms is None:
        return True
    if token_iat_ms is not None:
        return int(token_iat_ms) <= revoked_before_ms
    token_iat = int(token_iat or 0)
    if revoked_before_ms and token_iat <= revoked_before_ms // 1000:
        return True
    return _legacy_redis_revoked(user_id, token_iat)


def _set_user_from_token(request: Request, token: str, db: Session | None = None):
    """Validate a bearer token and populate request.state.user.

    Raises HTTPException(401) when the token is invalid, expired or revoked.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])

        # Check per-token blacklist
        jti = payload.get("jti")
        if jti and is_token_blacklisted(jti):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": {"code": "AUTH_REVOKED", "message": "Token has been revoked"}},
                headers={"WWW-Authenticate": "Bearer"},
            )

        # Check user-level revocation
        user_id = int(payload["sub"])
        if _is_user_revoked(user_id, payload.get("iat", 0), payload.get("iat_ms"), db):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": {"code": "AUTH_REVOKED", "message": "All sessions have been revoked"}},
                headers={"WWW-Authenticate": "Bearer"},
            )

        request.state.user = {
            "id": user_id,
            "username": payload["username"],
            "role": payload["role"],
        }
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "AUTH_EXPIRED", "message": "Token expired"}},
            headers={"WWW-Authenticate": "Bearer"},
        )
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "AUTH_INVALID", "message": "Invalid token"}},
            headers={"WWW-Authenticate": "Bearer"},
        )


def _require_auth(
    request: HTTPConnection,
    credentials: HTTPAuthorizationCredentials = Security(_bearer),
    db: Session = Depends(get_db),
):
    if request.scope["type"] == "websocket":
        return  # WebSocket routes authenticate their single-use ticket themselves.
    # Authorization uses the server-parsed route path, never a URL reconstructed
    # from the untrusted Host header (which may contain path delimiters).
    if _is_auth_exempt(request.scope["path"], request.scope.get("method")):
        # Soft auth: a presented token is honored (so role-guarded endpoints on
        # exempt paths still work), but an absent or invalid token is tolerated.
        if credentials:
            try:
                _set_user_from_token(request, credentials.credentials, db)
            except HTTPException as exc:
                if exc.status_code != 401:
                    raise
        return
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "AUTH_MISSING", "message": "Missing token"}},
            headers={"WWW-Authenticate": "Bearer"},
        )

    _set_user_from_token(request, credentials.credentials, db)


def require_role(*roles):
    """Dependency factory: require the current user to have one of the given roles."""
    def _check(request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            # No user was resolved (e.g. exempt path) -- never let a
            # role-guarded endpoint through silently.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": {"code": "AUTH_REQUIRED", "message": "Authentication required"}},
                headers={"WWW-Authenticate": "Bearer"},
            )
        if user["role"] not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": {"code": "AUTH_FORBIDDEN", "message": f"Requires role: {', '.join(roles)}"}},
            )
    return Depends(_check)
