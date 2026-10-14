"""Shared test fixtures for the Net2Map backend test suite."""
import os
import sys
from unittest.mock import MagicMock

os.environ["DATABASE_URL"] = "sqlite://"
# JWT_SECRET and ENCRYPTION_KEY are mandatory at startup (config.validate_required_settings).
os.environ["JWT_SECRET"] = "test-jwt-secret"
os.environ["ENCRYPTION_KEY"] = "lwkSAQ_FAqRpXGylt2AyEJxT3o_OUR8hYap9ovksuW4="
os.environ["DEFAULT_ADMIN_PASSWORD"] = "test-admin-password"

# Patch JSONB -> JSON so SQLite works with PostgreSQL-specific columns
import sqlalchemy.dialects.postgresql as _pg
from sqlalchemy import JSON as _JSON

_pg.JSONB = _JSON

# Mock heavy / platform-specific modules that are not needed for API tests
for _mod in ("pysnmp", "pysnmp.hlapi", "snmp_scanner", "scan_engine", "scan_engine.scheduler"):
    sys.modules.setdefault(_mod, MagicMock())

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import database as _db_mod
from database import User
from main import app
from shared.auth import DUMMY_PASSWORD_HASH, clear_revocation_cache, create_token, hash_password

# In-memory SQLite engine with shared cache so all connections see the same DB
engine = create_engine(
    "sqlite:///:memory:?cache=shared",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Patch the module-level engine and SessionLocal so file_settings and other
# imports that use database.SessionLocal also hit the test database.
_db_mod.engine = engine
_db_mod.SessionLocal = TestSession


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "requires_postgres: test requires PostgreSQL (skipped with SQLite)"
    )


@pytest.fixture(autouse=True)
def setup_db():
    _db_mod.Base.metadata.create_all(bind=engine)
    # User ids restart per test; never reuse cached revocation state.
    clear_revocation_cache()
    yield
    _db_mod.Base.metadata.drop_all(bind=engine)
    clear_revocation_cache()


@pytest.fixture
def db():
    session = TestSession()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[_db_mod.get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def auth_headers(db):
    """JWT headers of a dedicated admin user (replaces the retired static test token)."""
    user = db.query(User).filter(User.username == "testtoken-admin").first()
    if user is None:
        user = User(
            username="testtoken-admin", email="", hashed_pw=DUMMY_PASSWORD_HASH,
            role="admin", is_active=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return {"Authorization": f"Bearer {create_token(user.id, user.username, user.role)}"}


@pytest.fixture
def jwt_headers(db):
    """Create a test admin user and return JWT auth headers."""
    user = User(
        username="testadmin", email="admin@test.com",
        hashed_pw=hash_password("TestPass123"), role="admin", is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_token(user.id, user.username, user.role)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def viewer_jwt_headers(db):
    """Create a test viewer user and return JWT auth headers."""
    user = User(
        username="testviewer", email="viewer@test.com",
        hashed_pw=hash_password("ViewPass123"), role="viewer", is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_token(user.id, user.username, user.role)
    return {"Authorization": f"Bearer {token}"}
