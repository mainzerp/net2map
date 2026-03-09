"""Authentication: JWT tokens, bcrypt passwords, role-based guards."""
import logging
import os
from datetime import datetime, timezone, timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_log = logging.getLogger(__name__)

JWT_SECRET = os.getenv("JWT_SECRET", os.getenv("SECRET_TOKEN", ""))
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = int(os.getenv("JWT_EXPIRY_HOURS", "24"))

# Backward compat: legacy single-token mode
_LEGACY_TOKEN = os.getenv("SECRET_TOKEN", "")

if not JWT_SECRET and not _LEGACY_TOKEN:
    _log.warning("Neither JWT_SECRET nor SECRET_TOKEN is set -- API authentication is DISABLED")

_bearer = HTTPBearer(auto_error=False)

_AUTH_EXEMPT_PATHS = {"/health", "/api/auth/login", "/metrics", "/api/map-background"}


def create_token(user_id: int, username: str, role: str) -> str:
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def _require_auth(request: Request, credentials: HTTPAuthorizationCredentials = Security(_bearer)):
    if request.url.path in _AUTH_EXEMPT_PATHS:
        return
    if not JWT_SECRET and not _LEGACY_TOKEN:
        return  # auth disabled
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "AUTH_MISSING", "message": "Missing token"}},
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials

    # Legacy single-token support
    if _LEGACY_TOKEN and token == _LEGACY_TOKEN:
        request.state.user = {"id": 0, "username": "legacy", "role": "admin"}
        return

    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        request.state.user = {
            "id": int(payload["sub"]),
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


def require_role(*roles):
    """Dependency factory: require the current user to have one of the given roles."""
    def _check(request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            return  # auth disabled
        if user["role"] not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": {"code": "AUTH_FORBIDDEN", "message": f"Requires role: {', '.join(roles)}"}},
            )
    return Depends(_check)
