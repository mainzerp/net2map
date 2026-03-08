"""Shared test fixtures for the NetMap backend test suite."""
import os
import sys
from unittest.mock import MagicMock

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["SECRET_TOKEN"] = "test-token"
os.environ["ENCRYPTION_KEY"] = ""

# Patch JSONB -> JSON so SQLite works with PostgreSQL-specific columns
import sqlalchemy.dialects.postgresql as _pg
from sqlalchemy import JSON as _JSON
_pg.JSONB = _JSON

# Mock heavy / platform-specific modules that are not needed for API tests
for _mod in ("pysnmp", "pysnmp.hlapi", "snmp_scanner", "scan_engine"):
    sys.modules.setdefault(_mod, MagicMock())

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import database as _db_mod
from main import app

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


@pytest.fixture(autouse=True)
def setup_db():
    _db_mod.Base.metadata.create_all(bind=engine)
    yield
    _db_mod.Base.metadata.drop_all(bind=engine)


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
def auth_headers():
    return {"Authorization": "Bearer test-token"}
