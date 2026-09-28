"""Authentication: JWT tokens, bcrypt passwords, role-based guards."""
import logging
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config import settings

_log = logging.getLogger(__name__)

JWT_SECRET = settings.jwt_secret or settings.secret_token
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = settings.jwt_expiry_hours

# How long past `exp` a token may still be refreshed (see /api/auth/refresh).
# Blacklist/revocation entries must outlive this window, otherwise a revoked
# token could still be exchanged for a fresh one during the grace period.
REFRESH_GRACE_SECONDS = 3600

# Backward compat: legacy single-token mode. Only honored when JWT_SECRET is
# not set; once JWT auth is configured the static token must not grant access.
if settings.jwt_secret and settings.secret_token:
    _log.warning(
        "Both JWT_SECRET and SECRET_TOKEN are set -- ignoring legacy SECRET_TOKEN; "
        "only JWT authentication is accepted"
    )
_LEGACY_TOKEN = settings.secret_token if not settings.jwt_secret else ""

if not JWT_SECRET and not _LEGACY_TOKEN:
    _log.warning("Neither JWT_SECRET nor SECRET_TOKEN is set -- API authentication is DISABLED")

# Precomputed bcrypt hash used for dummy verification on login attempts with
# unknown usernames, so response timing does not reveal whether a user exists.
DUMMY_PASSWORD_HASH = "$2b$12$43/hneyCbrcdSGlerxj3M.rM1tEO9kzfsp4NT2v2eRpmA3GmFoowa"

_bearer = HTTPBearer(auto_error=False)

_AUTH_EXEMPT_PATHS = {"/health", "/api/auth/login", "/api/map-background", "/api/auth/refresh"}


def create_token(user_id: int, username: str, role: str) -> str:
    jti = str(uuid.uuid4())
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "jti": jti,
        "iat": int(datetime.now(timezone.utc).timestamp()),
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


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
        return False
    try:
        return r.exists(f"token_blacklist:{jti}") > 0
    except Exception:
        return False


def blacklist_all_user_tokens(user_id: int) -> bool:
    """Mark a user-scoped revocation key. All tokens issued before this time are invalid."""
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        return False
    try:
        r.set(
            f"token_revoke_all:{user_id}",
            str(int(datetime.now(timezone.utc).timestamp())),
            ex=JWT_EXPIRY_HOURS * 3600 + REFRESH_GRACE_SECONDS,
        )
        return True
    except Exception:
        return False


def _is_user_revoked(user_id: int, token_iat: int) -> bool:
    """Check if user-level revocation happened after this token was issued."""
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        return False
    try:
        revoked_at = r.get(f"token_revoke_all:{user_id}")
        # <= is intentional: iat has 1-second granularity, so a token issued in
        # the SAME second as the revocation must also count as revoked.
        if revoked_at and token_iat <= int(revoked_at):
            return True
        return False
    except Exception:
        return False


def _set_user_from_token(request: Request, token: str):
    """Validate a bearer token and populate request.state.user.

    Raises HTTPException(401) when the token is invalid, expired or revoked.
    """
    # Legacy single-token support
    if _LEGACY_TOKEN and token == _LEGACY_TOKEN:
        request.state.user = {"id": 0, "username": "legacy", "role": "admin"}
        return

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
        iat = payload.get("iat", 0)
        if _is_user_revoked(user_id, iat):
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
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "AUTH_INVALID", "message": "Invalid token"}},
            headers={"WWW-Authenticate": "Bearer"},
        )


def _require_auth(request: Request, credentials: HTTPAuthorizationCredentials = Security(_bearer)):
    if not JWT_SECRET and not _LEGACY_TOKEN:
        request.state.user = {"id": 0, "username": "anonymous", "role": "admin"}
        return  # auth disabled -- startup warning already logged
    if request.url.path in _AUTH_EXEMPT_PATHS:
        # Soft auth: a presented token is honored (so role-guarded endpoints on
        # exempt paths still work), but an absent or invalid token is tolerated.
        if credentials:
            try:
                _set_user_from_token(request, credentials.credentials)
            except HTTPException:
                pass
        return
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "AUTH_MISSING", "message": "Missing token"}},
            headers={"WWW-Authenticate": "Bearer"},
        )

    _set_user_from_token(request, credentials.credentials)


def require_role(*roles):
    """Dependency factory: require the current user to have one of the given roles."""
    def _check(request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            if JWT_SECRET or _LEGACY_TOKEN:
                # Auth is active but no user was resolved (e.g. exempt path) --
                # never let a role-guarded endpoint through silently.
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail={"error": {"code": "AUTH_REQUIRED", "message": "Authentication required"}},
                    headers={"WWW-Authenticate": "Bearer"},
                )
            return  # auth globally disabled
        if user["role"] not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": {"code": "AUTH_FORBIDDEN", "message": f"Requires role: {', '.join(roles)}"}},
            )
    return Depends(_check)
