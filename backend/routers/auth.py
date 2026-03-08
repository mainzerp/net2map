"""Authentication endpoints: login, current user, user management."""
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import User, get_db
from schemas import LoginRequest, TokenResponse, UserCreate, UserUpdate, UserOut
from shared.auth import create_token, hash_password, verify_password, require_role
from shared.audit import log_audit
from shared.errors import api_error

router = APIRouter()


@router.post("/api/auth/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(
        User.username == body.username, User.is_active == True
    ).first()
    if not user or not verify_password(body.password, user.hashed_pw):
        api_error(401, "AUTH_INVALID_CREDENTIALS", "Invalid username or password")
    token = create_token(user.id, user.username, user.role)
    return TokenResponse(access_token=token, role=user.role, username=user.username)


@router.get("/api/auth/me")
def get_current_user(request: Request):
    return getattr(request.state, "user", {"role": "admin", "username": "anonymous"})


@router.post("/api/users", response_model=UserOut, status_code=201,
             dependencies=[require_role("admin")])
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
def delete_user(user_id: int, request: Request, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        api_error(404, "USER_NOT_FOUND", "User not found")
    log_audit(request, "delete", "user", str(user_id), {"username": user.username})
    db.delete(user)
    db.commit()
