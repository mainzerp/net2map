"""Authentication endpoints: login, current user, user management."""
import json
import secrets
from typing import List, Optional

import jwt as pyjwt
from fastapi import APIRouter, Body, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import User, get_db
from schemas import LoginRequest, TokenResponse, UserCreate, UserOut, UserUpdate
from shared.audit import log_audit
from shared.auth import (
    JWT_ALGORITHM,
    JWT_SECRET,
    blacklist_all_user_tokens,
    blacklist_token,
    create_token,
    hash_password,
    require_role,
    verify_password,
)
from shared.errors import api_error
from shared.redis_client import get_redis

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.post("/api/auth/login", response_model=TokenResponse)
@limiter.limit("5/minute")
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    user = db.query(User).filter(
        User.username == body.username, User.is_active.is_(True)
    ).first()
    if not user or not verify_password(body.password, user.hashed_pw):
        api_error(401, "AUTH_INVALID_CREDENTIALS", "Invalid username or password")
    token = create_token(user.id, user.username, user.role)
    return TokenResponse(access_token=token, role=user.role, username=user.username)


@router.get("/api/auth/me")
def get_current_user(request: Request):
    return getattr(request.state, "user", {"role": "viewer", "username": "anonymous"})


@router.post("/api/auth/ws-ticket")
def create_ws_ticket(request: Request):
    """Issue a short-lived single-use ticket for WebSocket authentication.

    The ticket is stored in Redis with a 30-second TTL. The client passes
    the ticket as a query parameter when connecting to the WebSocket
    instead of the raw JWT, avoiding JWT exposure in URLs/logs.
    """
    user = getattr(request.state, "user", None)
    if not user:
        api_error(401, "AUTH_REQUIRED", "Authentication required")
    r = get_redis()
    if not r:
        api_error(503, "REDIS_UNAVAILABLE", "Ticket service unavailable; use token auth")
    ticket = secrets.token_urlsafe(32)
    r.set(f"ws_ticket:{ticket}", json.dumps(user), ex=30)
    return {"ticket": ticket}


@router.post("/api/auth/refresh", response_model=TokenResponse)
@limiter.limit("10/minute")
def refresh_token(request: Request, db: Session = Depends(get_db)):
    """Refresh a valid (or recently-expired) JWT token.

    Accepts the current token via Authorization header. If the token is
    valid or expired within the last 60 minutes, issues a new token.
    The user must still exist and be active in the database.
    """
    user_info = getattr(request.state, "user", None)
    if not user_info:
        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer "):
            api_error(401, "AUTH_REQUIRED", "Authentication required")
        token = auth_header[7:]
        try:
            payload = pyjwt.decode(
                token, JWT_SECRET, algorithms=[JWT_ALGORITHM],
                options={"verify_exp": False},
            )
            from datetime import datetime, timezone
            exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
            now = datetime.now(timezone.utc)
            if (now - exp).total_seconds() > 3600:
                api_error(401, "AUTH_EXPIRED", "Token expired beyond refresh window")
            user_info = {
                "id": int(payload["sub"]),
                "username": payload["username"],
                "role": payload["role"],
            }
        except Exception:
            api_error(401, "AUTH_INVALID", "Invalid token")

    user = db.query(User).filter(
        User.id == user_info["id"], User.is_active.is_(True)
    ).first()
    if not user:
        api_error(401, "AUTH_USER_INACTIVE", "User account is inactive or deleted")

    new_token = create_token(user.id, user.username, user.role)
    return TokenResponse(access_token=new_token, role=user.role, username=user.username)


@router.post("/api/users", response_model=UserOut, status_code=201,
             dependencies=[require_role("admin")])
@limiter.limit("10/minute")
def create_user(body: UserCreate, request: Request, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.username == body.username).first()
    if existing:
        api_error(400, "USER_EXISTS", f"Username '{body.username}' already exists", field="username")
    user = User(
        username=body.username,
        email=body.email,
        hashed_pw=hash_password(body.password),
        role=body.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    log_audit(request, "create", "user", str(user.id), {"username": user.username, "role": user.role})
    return user


@router.get("/api/users", response_model=List[UserOut],
            dependencies=[require_role("admin")])
def list_users(db: Session = Depends(get_db)):
    return db.query(User).order_by(User.id).all()


@router.put("/api/users/{user_id}", response_model=UserOut,
            dependencies=[require_role("admin")])
@limiter.limit("10/minute")
def update_user(user_id: int, body: UserUpdate, request: Request, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        api_error(404, "USER_NOT_FOUND", "User not found")
    updates = body.model_dump(exclude_none=True)
    if "password" in updates:
        updates["hashed_pw"] = hash_password(updates.pop("password"))
    for k, v in updates.items():
        setattr(user, k, v)
    db.commit()
    db.refresh(user)
    log_audit(request, "update", "user", str(user_id), {"fields": list(body.model_dump(exclude_none=True).keys())})
    return user


@router.delete("/api/users/{user_id}", status_code=204,
               dependencies=[require_role("admin")])
@limiter.limit("10/minute")
def delete_user(user_id: int, request: Request, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        api_error(404, "USER_NOT_FOUND", "User not found")
    log_audit(request, "delete", "user", str(user_id), {"username": user.username})
    db.delete(user)
    db.commit()


@router.post("/api/auth/logout")
def logout_token(request: Request):
    """Blacklist the current token so it can no longer be used."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        api_error(401, "AUTH_REQUIRED", "Authentication required")
    token = auth_header[7:]
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        jti = payload.get("jti")
        exp = payload.get("exp", 0)
        if jti:
            import time
            remaining = max(0, exp - int(time.time()))
            blacklist_token(jti, remaining)
    except Exception:
        pass  # Token already invalid/expired -- no-op
    return {"status": "ok"}


@router.post("/api/auth/revoke-all", dependencies=[require_role("admin")])
def revoke_all_sessions(request: Request, user_id: Optional[int] = Body(None, embed=True)):
    """Revoke all active sessions for a user (admin only).

    Accepts optional JSON body with user_id to revoke another user's sessions.
    If no body or no user_id, revokes sessions for the requesting user.
    """
    user = getattr(request.state, "user", {})
    target_id = user_id if user_id is not None else user.get("id", 0)
    blacklist_all_user_tokens(target_id)
    log_audit(request, "revoke_all_tokens", "user", str(target_id), {})
    return {"status": "ok", "user_id": target_id}
