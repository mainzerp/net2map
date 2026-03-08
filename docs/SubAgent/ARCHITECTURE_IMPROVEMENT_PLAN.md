# Architecture Improvement Plan - NetMap

**Source**: [DEEP_CODE_REVIEW_ANALYSIS.md](DEEP_CODE_REVIEW_ANALYSIS.md)
**Created**: 2026-03-08
**Scope**: 19 items across 7 implementation phases
**Estimated Files Touched**: ~60 (new + modified)

---

## Table of Contents

1. [Phase 1: Foundation](#phase-1-foundation)
2. [Phase 2: Security & Access Control](#phase-2-security--access-control)
3. [Phase 3: Scalability](#phase-3-scalability)
4. [Phase 4: Scanner Improvements](#phase-4-scanner-improvements)
5. [Phase 5: Frontend Improvements](#phase-5-frontend-improvements)
6. [Phase 6: Observability & Operations](#phase-6-observability--operations)
7. [Phase 7: Remaining Items](#phase-7-remaining-items)

---

## Phase 1: Foundation

These items must be completed first as they establish patterns used by all subsequent phases.

---

### 1.1 Structured Error Responses

**Complexity**: Moderate
**Dependencies**: None (foundational)
**New files**: None
**Modified files**: `backend/schemas.py`, `backend/main.py`, all `backend/routers/*.py`

#### Objective

Replace ad-hoc `HTTPException(status_code, "string")` calls with a structured `ErrorDetail` Pydantic model so every error response has a consistent JSON shape: `{"error": {"code": "...", "message": "...", "details": [...]}}`.

#### Checklist

- [ ] **Define error schemas in `backend/schemas.py`**

  Add at the top of the schemas file:

  ```python
  class ErrorDetail(BaseModel):
      code: str                        # machine-readable: "CREDENTIAL_NOT_FOUND"
      message: str                     # human-readable
      field: Optional[str] = None      # for validation errors, which field
      details: Optional[List[dict]] = None  # additional context

  class APIError(BaseModel):
      error: ErrorDetail
  ```

- [ ] **Create error helper in `backend/shared/errors.py`** (new file)

  ```python
  from fastapi import HTTPException
  from fastapi.responses import JSONResponse

  def api_error(status_code: int, code: str, message: str, field: str = None, details: list = None):
      body = {"error": {"code": code, "message": message}}
      if field:
          body["error"]["field"] = field
      if details:
          body["error"]["details"] = details
      raise HTTPException(status_code=status_code, detail=body)
  ```

- [ ] **Update global exception handler in `backend/main.py`**

  Currently at line 70:
  ```python
  @app.exception_handler(Exception)
  async def global_exception_handler(request, exc):
      _log.exception("Unhandled error")
      return JSONResponse(status_code=500, content={"detail": "Internal server error"})
  ```
  Change to:
  ```python
  @app.exception_handler(Exception)
  async def global_exception_handler(request, exc):
      _log.exception("Unhandled error")
      return JSONResponse(status_code=500, content={
          "error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}
      })

  @app.exception_handler(HTTPException)
  async def http_exception_handler(request, exc):
      detail = exc.detail
      if isinstance(detail, dict) and "error" in detail:
          return JSONResponse(status_code=exc.status_code, content=detail)
      return JSONResponse(status_code=exc.status_code, content={
          "error": {"code": "HTTP_ERROR", "message": str(detail)}
      })
  ```

- [ ] **Update all router HTTPExceptions** (14 routers)

  Each router's `raise HTTPException(...)` calls must use the structured format. Example transformations:

  `backend/routers/credentials.py` line 18:
  ```python
  # Before:
  raise HTTPException(400, f"IP {body.ip} already exists")
  # After:
  from shared.errors import api_error
  api_error(400, "CREDENTIAL_IP_EXISTS", f"IP {body.ip} already exists", field="ip")
  ```

  `backend/routers/credentials.py` line 36:
  ```python
  # Before:
  raise HTTPException(404, "Credential not found")
  # After:
  api_error(404, "CREDENTIAL_NOT_FOUND", "Credential not found")
  ```

  Routers to update (each has 1-5 HTTPException calls):
  - `credentials.py` (3 calls: lines 18, 36, 59)
  - `snmp_profiles.py` (2 calls: lines 28, 43)
  - `racks.py` (2 calls: lines 29, 39)
  - `switch_classes.py` (2 calls: lines 29, 39)
  - `switch_models.py` (2 calls: lines 29, 39)
  - `topology.py` (6 calls: lines 63, 77, 96, 107, 113, 119)
  - `scan.py` (2 calls: lines 33, 48)
  - `map_bg.py` (4 calls: lines 38, 43, 49, 65)
  - `scan_settings.py` (2 calls: lines 33, 55)
  - `bulk.py` (3 calls: lines 56, 60, 100)
  - `config.py` (4 calls: lines 23, 27, 30, 33)
  - `health.py` (0 calls)
  - `logs.py` (0 calls)
  - `settings.py` (0 calls)

- [ ] **Update `backend/shared/auth.py`** authentication error:

  Line 24:
  ```python
  # Before:
  raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or missing token", ...)
  # After:
  raise HTTPException(
      status_code=status.HTTP_401_UNAUTHORIZED,
      detail={"error": {"code": "AUTH_INVALID_TOKEN", "message": "Invalid or missing token"}},
      headers={"WWW-Authenticate": "Bearer"},
  )
  ```

- [ ] **Update frontend `api.js`** to parse new error format:

  In the `_checkOk` function (line 14):
  ```javascript
  async function _checkOk(r) {
    if (!r.ok) {
      let msg;
      try {
        const body = await r.json();
        msg = body?.error?.message || body?.detail || r.statusText;
      } catch {
        try { msg = await r.text(); } catch { msg = r.statusText; }
      }
      throw new Error(`HTTP ${r.status}: ${msg}`);
    }
    return r;
  }
  ```

---

### 1.2 Comprehensive Input Validation

**Complexity**: Moderate
**Dependencies**: None (foundational; item 1.1 is recommended first for error format consistency)
**New files**: None
**Modified files**: `backend/schemas.py`, `backend/routers/scan_settings.py`, `backend/routers/map_bg.py`, `backend/routers/scan.py`

#### Objective

Replace `request.json()` raw dict parsing with Pydantic models for ALL input endpoints. Currently, `scan_settings.py`, `map_bg.py` (map-settings), and `scan_settings.py` (dns-settings, discovery-ranges) use raw `request.json()`.

#### Checklist

- [ ] **Add missing Pydantic models in `backend/schemas.py`**

  ```python
  # ---- Scan Settings ----
  class ScanSettingsUpdate(BaseModel):
      max_workers: Optional[int] = None
      snmp_timeout: Optional[int] = None
      snmp_retries: Optional[int] = None

      @model_validator(mode="after")
      def _clamp_values(self):
          if self.max_workers is not None:
              self.max_workers = max(1, min(128, self.max_workers))
          if self.snmp_timeout is not None:
              self.snmp_timeout = max(1, min(30, self.snmp_timeout))
          if self.snmp_retries is not None:
              self.snmp_retries = max(0, min(10, self.snmp_retries))
          return self

  class ScanSettingsOut(BaseModel):
      max_workers: int
      snmp_timeout: int
      snmp_retries: int

  # ---- DNS Settings ----
  class DnsSettingsUpdate(BaseModel):
      servers: List[str] = []

  class DnsSettingsOut(BaseModel):
      servers: List[str]

  # ---- Discovery Ranges ----
  class DiscoveryRangesUpdate(BaseModel):
      ranges: List[str] = []

  class DiscoveryRangesOut(BaseModel):
      ranges: List[str]

  # ---- Map Settings ----
  class MapSettingsUpdate(BaseModel):
      opacity: Optional[float] = None
      scale: Optional[float] = None
      bg_color: Optional[str] = None

      @model_validator(mode="after")
      def _clamp_and_sanitize(self):
          if self.opacity is not None:
              self.opacity = max(0.0, min(1.0, self.opacity))
          if self.scale is not None:
              self.scale = max(0.1, min(10.0, self.scale))
          if self.bg_color is not None:
              self.bg_color = self.bg_color[:20]
          return self

  class MapSettingsOut(BaseModel):
      opacity: float
      scale: float
      bg_color: str

  # ---- Scan Job Request ----
  class ScanJobRequest(BaseModel):
      scan_type: Optional[str] = "full"
  ```

- [ ] **Update `backend/routers/scan_settings.py`**

  Replace `update_scan_settings` (line 26):
  ```python
  # Before:
  @router.put("/api/scan-settings")
  async def update_scan_settings(request: Request):
      body = await request.json()
      return _write_scan_settings(body)

  # After:
  @router.put("/api/scan-settings", response_model=ScanSettingsOut)
  def update_scan_settings(body: ScanSettingsUpdate):
      return _write_scan_settings(body.model_dump(exclude_none=True))
  ```

  Replace `update_discovery_ranges` (line 34):
  ```python
  # Before:
  @router.put("/api/discovery-ranges")
  async def update_discovery_ranges(request: Request, db: Session = Depends(get_db)):
      body = await request.json()
      raw_ranges = body.get("ranges", [])
      ...

  # After:
  @router.put("/api/discovery-ranges", response_model=DiscoveryRangesOut)
  def update_discovery_ranges(body: DiscoveryRangesUpdate, db: Session = Depends(get_db)):
      validated = []
      for entry in body.ranges:
          entry = entry.strip()
          ...
  ```

  Replace `update_dns_settings` (line 62):
  ```python
  # Before:
  @router.put("/api/dns-settings")
  async def update_dns_settings(request: Request):
      body = await request.json()
      return _write_dns_settings(body.get("servers", []))

  # After:
  @router.put("/api/dns-settings", response_model=DnsSettingsOut)
  def update_dns_settings(body: DnsSettingsUpdate):
      return _write_dns_settings(body.servers)
  ```

- [ ] **Update `backend/routers/map_bg.py`** `update_map_settings` (line 78):
  ```python
  # Before:
  @router.put("/api/map-settings")
  async def update_map_settings(request: Request):
      body = await request.json()
      allowed = {}
      if "opacity" in body: allowed["opacity"] = float(body["opacity"])
      ...

  # After:
  @router.put("/api/map-settings", response_model=MapSettingsOut)
  def update_map_settings(body: MapSettingsUpdate):
      return _write_map_settings(body.model_dump(exclude_none=True))
  ```

- [ ] **Add `response_model` annotations** to all GET endpoints that currently lack them:
  - `GET /api/scan-settings` -> `response_model=ScanSettingsOut`
  - `GET /api/dns-settings` -> `response_model=DnsSettingsOut`
  - `GET /api/discovery-ranges` -> `response_model=DiscoveryRangesOut`
  - `GET /api/map-settings` -> `response_model=MapSettingsOut`

---

### 1.3 Consolidate Settings into Database

**Complexity**: Complex
**Dependencies**: Item 1.2 (Pydantic models for settings)
**New files**: `backend/alembic/versions/005_settings_to_db.py`
**Modified files**: `backend/database.py`, `backend/shared/file_settings.py`, `backend/routers/scan_settings.py`, `backend/routers/map_bg.py`, `backend/scan_engine.py`

#### Objective

Migrate `scan-settings.json`, `map-settings.json`, and `dns-settings.json` from file-based storage into the `AppSetting` database table. Remove file I/O dependency from settings reads/writes. The `/data` volume is still needed for the map background image.

#### Checklist

- [ ] **Create Alembic migration `005_settings_to_db.py`**

  Insert default rows for new settings keys:
  ```python
  def upgrade():
      op.execute("""
          INSERT INTO app_settings (key, value) VALUES
              ('scan_max_workers', '4'),
              ('scan_snmp_timeout', '3'),
              ('scan_snmp_retries', '1'),
              ('dns_servers', '[]'),
              ('map_opacity', '0.3'),
              ('map_scale', '1.0'),
              ('map_bg_color', '#020817')
          ON CONFLICT (key) DO NOTHING
      """)

  def downgrade():
      op.execute("""
          DELETE FROM app_settings WHERE key IN (
              'scan_max_workers', 'scan_snmp_timeout', 'scan_snmp_retries',
              'dns_servers', 'map_opacity', 'map_scale', 'map_bg_color'
          )
      """)
  ```

- [ ] **Add DB-backed settings helpers in `backend/shared/file_settings.py`**

  Add new functions that read/write from AppSetting instead of JSON files:
  ```python
  from database import AppSetting, SessionLocal

  def _read_db_setting(key: str, default: str = "") -> str:
      db = SessionLocal()
      try:
          row = db.query(AppSetting).filter(AppSetting.key == key).first()
          return row.value if row else default
      finally:
          db.close()

  def _write_db_setting(key: str, value: str):
      db = SessionLocal()
      try:
          row = db.query(AppSetting).filter(AppSetting.key == key).first()
          if row:
              row.value = value
          else:
              db.add(AppSetting(key=key, value=value))
          db.commit()
      finally:
          db.close()

  def _read_scan_settings() -> dict:
      return {
          "max_workers": max(1, min(128, int(_read_db_setting("scan_max_workers", "4")))),
          "snmp_timeout": max(1, min(30, int(_read_db_setting("scan_snmp_timeout", "3")))),
          "snmp_retries": max(0, min(10, int(_read_db_setting("scan_snmp_retries", "1")))),
      }

  def _write_scan_settings(data: dict) -> dict:
      normalized = _normalize_scan_settings(data)
      _write_db_setting("scan_max_workers", str(normalized["max_workers"]))
      _write_db_setting("scan_snmp_timeout", str(normalized["snmp_timeout"]))
      _write_db_setting("scan_snmp_retries", str(normalized["snmp_retries"]))
      return normalized

  def _read_dns_settings() -> dict:
      raw = _read_db_setting("dns_servers", "[]")
      try:
          servers = json.loads(raw)
          return {"servers": servers if isinstance(servers, list) else []}
      except Exception:
          return {"servers": []}

  def _write_dns_settings(servers: list) -> dict:
      validated = _normalize_dns_servers(servers)
      _write_db_setting("dns_servers", json.dumps(validated))
      return {"servers": validated}

  def _read_map_settings() -> dict:
      return {
          "opacity": float(_read_db_setting("map_opacity", "0.3")),
          "scale": float(_read_db_setting("map_scale", "1.0")),
          "bg_color": _read_db_setting("map_bg_color", "#020817"),
      }

  def _write_map_settings(data: dict) -> dict:
      current = _read_map_settings()
      merged = {**current, **data}
      _write_db_setting("map_opacity", str(merged["opacity"]))
      _write_db_setting("map_scale", str(merged["scale"]))
      _write_db_setting("map_bg_color", merged["bg_color"])
      return merged
  ```

- [ ] **Remove JSON file I/O constants** from `file_settings.py`:
  Remove `SCAN_SETTINGS_PATH`, `DNS_SETTINGS_PATH`, `MAP_SETTINGS_PATH` and their file-based read/write functions. Keep map background file functions (`_find_bg_file`, `_clear_bg_files`, etc.) since the image itself remains file-based.

- [ ] **Remove `portalocker` dependency** from `requirements.txt` (no longer needed once file settings are removed).

- [ ] **Update `backend/scan_engine.py`** `_execute_scan` (line 287): `_read_scan_settings()` and `_read_dns_settings()` already imported from `shared.file_settings` -- no import change needed, only the underlying implementation changes.

- [ ] **Update `backend/database.py`** `_seed_default_settings()` (line 213): Add the new settings keys to the seed defaults:
  ```python
  defaults = [
      ("discovery_interval_sec", "1800"),
      ("port_update_interval_sec", "30"),
      ("discovery_scan_ranges", "[]"),
      ("scan_max_workers", "4"),
      ("scan_snmp_timeout", "3"),
      ("scan_snmp_retries", "1"),
      ("dns_servers", "[]"),
      ("map_opacity", "0.3"),
      ("map_scale", "1.0"),
      ("map_bg_color", "#020817"),
  ]
  ```

- [ ] **Test**: Verify settings persist across container restarts (DB-backed) and that the migration path works: `alembic upgrade head` should insert default setting rows without error.

---

### 1.4 Test Infrastructure Setup

**Complexity**: Moderate
**Dependencies**: None (can be done in parallel with 1.1-1.3)
**New files**: `backend/tests/conftest.py`, `backend/tests/test_health.py`, `backend/tests/test_credentials.py`, `backend/tests/test_schemas.py`, `frontend/vitest.config.js`, `frontend/src/__tests__/api.test.js`, `.github/workflows/ci.yml`
**Modified files**: `backend/requirements.txt`, `frontend/package.json`

#### Checklist

- [ ] **Backend: Add test dependencies to `backend/requirements.txt`**
  ```
  pytest>=8.0.0
  pytest-asyncio>=0.23.0
  httpx>=0.27.0
  ```

- [ ] **Create `backend/tests/__init__.py`** (empty)

- [ ] **Create `backend/tests/conftest.py`**
  ```python
  import os
  os.environ["DATABASE_URL"] = "sqlite:///./test.db"
  os.environ["SECRET_TOKEN"] = "test-token"
  os.environ["ENCRYPTION_KEY"] = ""

  import pytest
  from fastapi.testclient import TestClient
  from sqlalchemy import create_engine
  from sqlalchemy.orm import sessionmaker

  from database import Base, get_db
  from main import app

  engine = create_engine("sqlite:///./test.db", connect_args={"check_same_thread": False})
  TestSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

  @pytest.fixture(autouse=True)
  def setup_db():
      Base.metadata.create_all(bind=engine)
      yield
      Base.metadata.drop_all(bind=engine)

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
      app.dependency_overrides[get_db] = override_get_db
      with TestClient(app) as c:
          yield c
      app.dependency_overrides.clear()

  @pytest.fixture
  def auth_headers():
      return {"Authorization": "Bearer test-token"}
  ```

- [ ] **Create `backend/tests/test_health.py`**
  ```python
  def test_health_no_auth(client):
      r = client.get("/health")
      assert r.status_code == 200
      assert r.json()["status"] == "ok"
  ```

- [ ] **Create `backend/tests/test_credentials.py`**
  ```python
  def test_create_credential(client, auth_headers):
      r = client.post("/api/credentials", json={
          "label": "Test Switch", "ip": "10.0.0.1",
      }, headers=auth_headers)
      assert r.status_code == 201
      assert r.json()["ip"] == "10.0.0.1"

  def test_duplicate_ip_rejected(client, auth_headers):
      client.post("/api/credentials", json={"label": "A", "ip": "10.0.0.1"}, headers=auth_headers)
      r = client.post("/api/credentials", json={"label": "B", "ip": "10.0.0.1"}, headers=auth_headers)
      assert r.status_code == 400

  def test_list_credentials(client, auth_headers):
      r = client.get("/api/credentials", headers=auth_headers)
      assert r.status_code == 200
      assert isinstance(r.json(), list)
  ```

- [ ] **Create `backend/tests/test_schemas.py`**
  ```python
  from schemas import CredentialCreate, SnmpProfileCreate

  def test_credential_create_defaults():
      c = CredentialCreate(label="test", ip="10.0.0.1")
      assert c.snmp_version == "v2c"
      assert c.snmp_port == 161

  def test_invalid_snmp_version():
      import pytest
      with pytest.raises(Exception):
          CredentialCreate(label="test", ip="10.0.0.1", snmp_version="v4")
  ```

- [ ] **Frontend: Add vitest to `frontend/package.json`**
  ```json
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.2",
    "vite": "^5.4.10",
    "vitest": "^1.6.0",
    "@testing-library/react": "^14.3.0",
    "jsdom": "^24.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
  ```

- [ ] **Create `frontend/vitest.config.js`**
  ```javascript
  import { defineConfig } from "vitest/config";
  import react from "@vitejs/plugin-react";

  export default defineConfig({
    plugins: [react()],
    test: {
      environment: "jsdom",
      globals: true,
    },
  });
  ```

- [ ] **Create `frontend/src/__tests__/api.test.js`**
  ```javascript
  import { speedLabel, normPort, buildPortLinkMap } from "../api.js";

  test("speedLabel returns correct tiers", () => {
    expect(speedLabel(100000)).toBe("100G");
    expect(speedLabel(40000)).toBe("40G");
    expect(speedLabel(25000)).toBe("25G");
    expect(speedLabel(10000)).toBe("10G");
    expect(speedLabel(1000)).toBe("1G");
    expect(speedLabel(100)).toBe("100M");
    expect(speedLabel(10)).toBe("10M");
    expect(speedLabel(0)).toBe("?");
  });

  test("normPort trims and lowercases", () => {
    expect(normPort("  Eth1/1  ")).toBe("eth1/1");
    expect(normPort(null)).toBe("");
  });
  ```

- [ ] **Create `.github/workflows/ci.yml`** (initial -- expanded in Phase 6)
  ```yaml
  name: CI
  on: [push, pull_request]

  jobs:
    backend-tests:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-python@v5
          with:
            python-version: "3.12"
        - run: pip install -r backend/requirements.txt
        - run: pip install pytest pytest-asyncio httpx
        - run: cd backend && python -m pytest tests/ -v
          env:
            DATABASE_URL: "sqlite:///./test.db"
            SECRET_TOKEN: "test-token"

    frontend-tests:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: "20"
        - run: cd frontend && npm ci
        - run: cd frontend && npm test
  ```

---

## Phase 2: Security & Access Control

---

### 2.1 Role-Based Access Control (RBAC)

**Complexity**: Complex
**Dependencies**: Phase 1 (structured errors, input validation, test infra)
**New files**: `backend/alembic/versions/006_add_users_table.py`, `backend/routers/auth.py`
**Modified files**: `backend/database.py`, `backend/schemas.py`, `backend/shared/auth.py`, `backend/main.py`, all `backend/routers/*.py`

#### Objective

Add a `User` table with role-based access (admin, operator, viewer), JWT token management, and decorator-based route protection. Replace the current single SECRET_TOKEN approach.

#### Checklist

- [ ] **Add `PyJWT` to `backend/requirements.txt`**
  ```
  PyJWT>=2.8.0
  bcrypt>=4.1.0
  ```

- [ ] **Add User model to `backend/database.py`**
  ```python
  class User(Base):
      __tablename__ = "users"

      id          = Column(Integer, primary_key=True, index=True)
      username    = Column(String, nullable=False, unique=True, index=True)
      email       = Column(String, default="")
      hashed_pw   = Column(String, nullable=False)
      role        = Column(String, default="viewer")  # "admin" | "operator" | "viewer"
      is_active   = Column(Boolean, default=True)
      created_at  = Column(DateTime, server_default=func.now())
      updated_at  = Column(DateTime, server_default=func.now(), onupdate=func.now())
  ```

- [ ] **Create Alembic migration `006_add_users_table.py`**
  - Creates `users` table
  - Seeds a default admin user (username: `admin`, password from `DEFAULT_ADMIN_PASSWORD` env var or `changeme`)
  - Password stored as bcrypt hash

- [ ] **Add auth schemas to `backend/schemas.py`**
  ```python
  class LoginRequest(BaseModel):
      username: str
      password: str

  class TokenResponse(BaseModel):
      access_token: str
      token_type: str = "bearer"
      role: str
      username: str

  class UserCreate(BaseModel):
      username: str
      email: str = ""
      password: str
      role: Literal["admin", "operator", "viewer"] = "viewer"

  class UserOut(BaseModel):
      id: int
      username: str
      email: str
      role: str
      is_active: bool
      created_at: datetime
      class Config:
          from_attributes = True
  ```

- [ ] **Rewrite `backend/shared/auth.py`**

  Replace the current single-token check with JWT + role checking:
  ```python
  import os, logging, jwt, bcrypt
  from datetime import datetime, timezone, timedelta
  from fastapi import HTTPException, Request, Security, status
  from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

  JWT_SECRET = os.getenv("JWT_SECRET", os.getenv("SECRET_TOKEN", ""))
  JWT_ALGORITHM = "HS256"
  JWT_EXPIRY_HOURS = int(os.getenv("JWT_EXPIRY_HOURS", "24"))

  # Backward compat: if SECRET_TOKEN is set and JWT_SECRET is not,
  # still accept the old bearer token for migration period
  _LEGACY_TOKEN = os.getenv("SECRET_TOKEN", "")
  _bearer = HTTPBearer(auto_error=False)
  _AUTH_EXEMPT_PATHS = {"/health", "/api/auth/login"}

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
          raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"error": {"code": "AUTH_MISSING", "message": "Missing token"}})

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
          raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"error": {"code": "AUTH_EXPIRED", "message": "Token expired"}})
      except jwt.InvalidTokenError:
          raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"error": {"code": "AUTH_INVALID", "message": "Invalid token"}})

  def require_role(*roles):
      """Dependency factory: require the current user to have one of the given roles."""
      def _check(request: Request):
          user = getattr(request.state, "user", None)
          if not user:
              return  # auth disabled
          if user["role"] not in roles:
              raise HTTPException(status.HTTP_403_FORBIDDEN, detail={"error": {"code": "AUTH_FORBIDDEN", "message": f"Requires role: {', '.join(roles)}"}})
      return _check
  ```

- [ ] **Create `backend/routers/auth.py`**
  ```python
  from fastapi import APIRouter, Depends, HTTPException
  from sqlalchemy.orm import Session
  from database import User, get_db
  from schemas import LoginRequest, TokenResponse, UserCreate, UserOut
  from shared.auth import create_token, hash_password, verify_password, require_role

  router = APIRouter()

  @router.post("/api/auth/login", response_model=TokenResponse)
  def login(body: LoginRequest, db: Session = Depends(get_db)):
      user = db.query(User).filter(User.username == body.username, User.is_active == True).first()
      if not user or not verify_password(body.password, user.hashed_pw):
          raise HTTPException(401, detail={"error": {"code": "AUTH_INVALID_CREDENTIALS", "message": "Invalid username or password"}})
      token = create_token(user.id, user.username, user.role)
      return TokenResponse(access_token=token, role=user.role, username=user.username)

  @router.get("/api/auth/me")
  def get_current_user(request):
      return getattr(request.state, "user", {"role": "admin", "username": "anonymous"})

  @router.post("/api/users", response_model=UserOut, status_code=201, dependencies=[Depends(require_role("admin"))])
  def create_user(body: UserCreate, db: Session = Depends(get_db)):
      ...

  @router.get("/api/users", response_model=list[UserOut], dependencies=[Depends(require_role("admin"))])
  def list_users(db: Session = Depends(get_db)):
      ...
  ```

- [ ] **Register auth router in `backend/main.py`**
  ```python
  from routers import auth
  app.include_router(auth.router)
  ```

- [ ] **Apply role guards to destructive endpoints**

  Pattern for each router (example `backend/routers/credentials.py`):
  ```python
  from shared.auth import require_role

  @router.post("/api/credentials", ..., dependencies=[Depends(require_role("admin", "operator"))])
  @router.delete("/api/credentials/{cred_id}", ..., dependencies=[Depends(require_role("admin"))])
  ```

  Role mapping:
  | Action | Required Role |
  |--------|--------------|
  | Read/list/topology | viewer, operator, admin |
  | Create/update credentials, profiles, settings | operator, admin |
  | Delete anything, scan trigger | admin |
  | User management | admin |

- [ ] **Update frontend** to add login page (new file `frontend/src/pages/LoginPage.jsx`) and store JWT in localStorage

---

### 2.2 Audit Trail

**Complexity**: Moderate
**Dependencies**: Item 2.1 (RBAC -- needs user context)
**New files**: `backend/alembic/versions/007_add_audit_log.py`, `backend/shared/audit.py`
**Modified files**: `backend/database.py`, `backend/schemas.py`, multiple routers

#### Objective

Log configuration changes (credential CRUD, settings updates, device ignore/enable, scan triggers) with timestamps, user info, action type, and before/after state.

#### Checklist

- [ ] **Add AuditLog model to `backend/database.py`**
  ```python
  class AuditLog(Base):
      __tablename__ = "audit_logs"

      id          = Column(Integer, primary_key=True, index=True)
      timestamp   = Column(DateTime, server_default=func.now(), index=True)
      user_id     = Column(Integer, nullable=True)
      username    = Column(String, default="")
      action      = Column(String, nullable=False)  # "create"|"update"|"delete"|"scan"|"settings_change"
      resource    = Column(String, nullable=False)   # "credential"|"snmp_profile"|"device"|"rack"|...
      resource_id = Column(String, default="")
      details     = Column(JSONB, default={})        # before/after state, changed fields
  ```

- [ ] **Create migration `007_add_audit_log.py`**

- [ ] **Create `backend/shared/audit.py`**
  ```python
  from database import AuditLog, SessionLocal
  from fastapi import Request

  def log_audit(request: Request, action: str, resource: str, resource_id: str = "", details: dict = None):
      user = getattr(request.state, "user", {})
      db = SessionLocal()
      try:
          db.add(AuditLog(
              user_id=user.get("id"),
              username=user.get("username", ""),
              action=action,
              resource=resource,
              resource_id=str(resource_id),
              details=details or {},
          ))
          db.commit()
      finally:
          db.close()
  ```

- [ ] **Instrument routers with audit calls**

  Example for `backend/routers/credentials.py` `create_credential`:
  ```python
  from shared.audit import log_audit

  @router.post("/api/credentials", ...)
  def create_credential(request: Request, body: CredentialCreate, db: Session = Depends(get_db)):
      ...
      db.commit()
      db.refresh(cred)
      log_audit(request, "create", "credential", str(cred.id), {"ip": cred.ip, "label": cred.label})
      return cred
  ```

  Routers to instrument:
  - `credentials.py` (create, update, delete)
  - `snmp_profiles.py` (create, update, delete)
  - `racks.py` (create, update, delete)
  - `switch_classes.py` (create, update, delete)
  - `switch_models.py` (create, update, delete)
  - `topology.py` (update_device_meta -- especially `ignored` changes)
  - `scan.py` (start_scan_job, cancel_scan_job)
  - `scan_settings.py` (update settings, ranges, dns)
  - `map_bg.py` (upload/delete background, map settings)
  - `config.py` (import)
  - `bulk.py` (import)
  - `settings.py` (update_setting)

- [ ] **Add audit log endpoint**
  ```python
  @router.get("/api/audit-logs", dependencies=[Depends(require_role("admin"))])
  def list_audit_logs(limit: int = 100, db: Session = Depends(get_db)):
      return db.query(AuditLog).order_by(AuditLog.timestamp.desc()).limit(min(500, limit)).all()
  ```

- [ ] **Add audit log schemas to `backend/schemas.py`**
  ```python
  class AuditLogOut(BaseModel):
      id: int
      timestamp: datetime
      username: str
      action: str
      resource: str
      resource_id: str
      details: Optional[dict] = None
      class Config:
          from_attributes = True
  ```

---

## Phase 3: Scalability

---

### 3.1 Redis State Migration

**Complexity**: Complex
**Dependencies**: Phase 1 complete
**New files**: `backend/shared/redis_client.py`
**Modified files**: `docker-compose.yml`, `backend/requirements.txt`, `backend/shared/state.py`, `backend/main.py`, `backend/scan_engine.py`, `backend/routers/logs.py`, `backend/routers/scan.py`, `backend/routers/topology.py`

#### Objective

Migrate `SCAN_JOBS` (dict), `LOG_BUFFER` (deque), and `_topo_cache` (dict) from in-process memory to Redis. This removes the single-worker constraint and allows horizontal scaling.

#### Checklist

- [ ] **Add Redis to `docker-compose.yml`**
  ```yaml
  redis:
    image: redis:7-alpine
    container_name: netmap-redis
    restart: unless-stopped
    networks:
      - netmap
    deploy:
      resources:
        limits:
          memory: 128M
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
  ```
  Add `REDIS_URL: "redis://redis:6379/0"` to the backend environment.

- [ ] **Add `redis` to `backend/requirements.txt`**
  ```
  redis>=5.0.0
  ```

- [ ] **Create `backend/shared/redis_client.py`**
  ```python
  import os
  import redis

  REDIS_URL = os.getenv("REDIS_URL", "")
  _pool = None

  def get_redis():
      global _pool
      if not REDIS_URL:
          return None
      if _pool is None:
          _pool = redis.ConnectionPool.from_url(REDIS_URL)
      return redis.Redis(connection_pool=_pool)
  ```

- [ ] **Refactor `backend/shared/state.py`**

  Replace in-process `LOG_BUFFER` and `SCAN_JOBS` with Redis-backed implementations that fall back to in-memory when Redis is unavailable:

  ```python
  import json
  from shared.redis_client import get_redis

  def _log_event(level, event, **fields):
      payload = {
          "ts": datetime.now(timezone.utc).isoformat() + "Z",
          "level": logging.getLevelName(level),
          "event": event,
          **fields,
      }
      r = get_redis()
      if r:
          r.lpush("netmap:logs", json.dumps(payload, default=str))
          r.ltrim("netmap:logs", 0, 4999)
      else:
          with LOG_BUFFER_LOCK:
              LOG_BUFFER.append(payload)
      log.log(level, json.dumps(payload, ensure_ascii=False))

  def get_log_entries(limit=200, level="", event_prefix="", query=""):
      r = get_redis()
      if r:
          raw = r.lrange("netmap:logs", 0, 4999)
          rows = [json.loads(x) for x in raw]
      else:
          with LOG_BUFFER_LOCK:
              rows = list(LOG_BUFFER)
      # Apply filters...
      return rows[-limit:]
  ```

  For `SCAN_JOBS`:
  ```python
  def set_scan_job(job_id, state_dict):
      r = get_redis()
      if r:
          r.hset("netmap:scan_jobs", job_id, json.dumps(state_dict, default=str))
          r.expire("netmap:scan_jobs", 3600)
      else:
          with SCAN_JOBS_LOCK:
              SCAN_JOBS[job_id] = state_dict

  def get_scan_job(job_id):
      r = get_redis()
      if r:
          raw = r.hget("netmap:scan_jobs", job_id)
          return json.loads(raw) if raw else None
      with SCAN_JOBS_LOCK:
          return SCAN_JOBS.get(job_id)
  ```

- [ ] **Refactor `backend/routers/topology.py` `_topo_cache`**

  Replace module-level `_topo_cache` dict with Redis:
  ```python
  def _get_topo_cache():
      r = get_redis()
      if r:
          raw = r.get("netmap:topo_cache")
          return json.loads(raw) if raw else {}
      return _topo_cache

  def _set_topo_cache(data):
      r = get_redis()
      if r:
          r.set("netmap:topo_cache", json.dumps(data), ex=300)
      else:
          global _topo_cache
          _topo_cache = data
  ```

- [ ] **Update `backend/routers/logs.py`** to use `get_log_entries()` instead of direct `LOG_BUFFER` access.

- [ ] **Update `backend/routers/scan.py`** to use `get_scan_job()`/`set_scan_job()` instead of `SCAN_JOBS` dict.

- [ ] **Remove single-worker warning** from `backend/main.py` line 38 once Redis is the primary state store.

- [ ] **Update `backend/Dockerfile` CMD** to allow `--workers 2` or more (currently hardcoded to `--workers 1`).

---

### 3.2 Background Queue (Celery)

**Complexity**: Complex
**Dependencies**: Item 3.1 (Redis must exist)
**New files**: `backend/celery_app.py`, `backend/tasks.py`
**Modified files**: `docker-compose.yml`, `backend/requirements.txt`, `backend/scan_engine.py`, `backend/routers/scan.py`, `backend/main.py`

#### Objective

Move scan execution from threading to Celery tasks with Redis as broker. Provides retry logic, task monitoring, and decouples scan work from the API process.

#### Checklist

- [ ] **Add Celery to `backend/requirements.txt`**
  ```
  celery[redis]>=5.3.0
  ```

- [ ] **Create `backend/celery_app.py`**
  ```python
  import os
  from celery import Celery

  REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

  celery_app = Celery("netmap", broker=REDIS_URL, backend=REDIS_URL)
  celery_app.conf.update(
      task_serializer="json",
      result_serializer="json",
      accept_content=["json"],
      task_track_started=True,
      task_acks_late=True,
      worker_prefetch_multiplier=1,
  )
  ```

- [ ] **Create `backend/tasks.py`**
  ```python
  import asyncio
  from celery_app import celery_app
  from database import SessionLocal
  from scan_engine import _execute_scan
  from shared.state import set_scan_job, _log_event
  import logging

  @celery_app.task(bind=True, max_retries=2, default_retry_delay=10)
  def run_scan_task(self, job_id, dry_run=False):
      db = SessionLocal()
      try:
          loop = asyncio.new_event_loop()
          asyncio.set_event_loop(loop)
          result = loop.run_until_complete(
              _execute_scan(db, correlation_id=job_id, dry_run=dry_run)
          )
          result_dict = result.model_dump()
          if dry_run:
              result_dict["preview"] = result.__dict__.get("_dry_run_preview", [])
          set_scan_job(job_id, {
              "id": job_id, "status": result.status,
              "result": result_dict,
          })
      except Exception as exc:
          _log_event(logging.ERROR, "celery.task.error", error=str(exc))
          self.retry(exc=exc)
      finally:
          db.close()
          loop.close()
  ```

- [ ] **Update `backend/routers/scan.py`** `_start_job` to dispatch Celery task:
  ```python
  from tasks import run_scan_task

  @router.post("/api/scan/jobs")
  def start_scan_job(request: Request):
      job_id = str(uuid.uuid4())
      set_scan_job(job_id, {"id": job_id, "status": "queued", ...})
      run_scan_task.delay(job_id, dry_run=False)
      return {"job_id": job_id, "status": "queued"}
  ```

- [ ] **Add Celery worker service to `docker-compose.yml`**
  ```yaml
  celery-worker:
    build: ./backend
    container_name: netmap-celery
    command: celery -A celery_app worker --loglevel=info --concurrency=2
    restart: unless-stopped
    environment:
      DATABASE_URL: "postgresql://netmap:${POSTGRES_PASSWORD:-netmap_pw}@postgres/netmap"
      REDIS_URL: "redis://redis:6379/0"
      ENCRYPTION_KEY: "${ENCRYPTION_KEY:-}"
    depends_on:
      redis: { condition: service_healthy }
      postgres: { condition: service_healthy }
    networks:
      - netmap
    deploy:
      resources:
        limits:
          memory: 512M
  ```

- [ ] **Keep the `_background_scheduler`** as a Celery beat task instead of a daemon thread (or keep it in the API process but dispatch scans via Celery).

---

## Phase 4: Scanner Improvements

---

### 4.1 Vendor Plugin System

**Complexity**: Complex
**Dependencies**: Phase 1 complete
**New files**: `backend/scanners/__init__.py`, `backend/scanners/base.py`, `backend/scanners/aruba_cx.py`, `backend/scanners/fs_scanner.py`, `backend/scanners/unifi.py`, `backend/scanners/opnsense.py`, `backend/scanners/generic.py`
**Modified files**: `backend/snmp_scanner.py`, `backend/scan_engine.py`

#### Objective

Extract vendor-specific scan logic from the monolithic `snmp_scanner.py` (currently 700+ lines) into pluggable scanner modules using an ABC base class. Each scanner handles its own model extraction, port filtering, FDB strategy, and LLDP parsing.

#### Checklist

- [ ] **Create `backend/scanners/__init__.py`**
  ```python
  from .base import VendorScanner
  from .aruba_cx import ArubaCXScanner
  from .fs_scanner import FSScanner
  from .unifi import UniFiScanner
  from .opnsense import OPNsenseScanner
  from .generic import GenericScanner

  SCANNER_REGISTRY = {
      "aruba_cx": ArubaCXScanner,
      "fs": FSScanner,
      "unifi": UniFiScanner,
      "opnsense": OPNsenseScanner,
      "generic": GenericScanner,
  }

  def get_scanner(vendor: str) -> VendorScanner:
      cls = SCANNER_REGISTRY.get(vendor, GenericScanner)
      return cls()
  ```

- [ ] **Create `backend/scanners/base.py`**
  ```python
  from abc import ABC, abstractmethod
  from dataclasses import dataclass
  from typing import Dict, List, Optional

  class VendorScanner(ABC):
      @abstractmethod
      def extract_model(self, sys_descr: str) -> str:
          """Extract model name from sysDescr."""
          ...

      @abstractmethod
      def is_virtual_port(self, if_descr: str) -> bool:
          """Return True if the interface is virtual (loopback, VLAN, mgmt, etc.)."""
          ...

      @abstractmethod
      def fdb_strategy(self) -> str:
          """Return 'dot1d' or 'qbridge' for MAC table walk strategy."""
          ...

      def speed_label(self, mbps: int) -> str:
          """Default speed label (shared across vendors)."""
          if mbps >= 100_000: return "100G"
          if mbps >= 40_000:  return "40G"
          if mbps >= 25_000:  return "25G"
          if mbps >= 10_000:  return "10G"
          if mbps >= 1_000:   return "1G"
          if mbps >= 100:     return "100M"
          return "10M"
  ```

- [ ] **Create per-vendor scanner files** (`aruba_cx.py`, `fs_scanner.py`, `unifi.py`, `opnsense.py`, `generic.py`)

  Move the existing vendor-specific logic from `snmp_scanner.py`:
  - `_VIRTUAL_ARUBA` -> `ArubaCXScanner.is_virtual_port()`
  - `_MODEL_ARUBA` regex -> `ArubaCXScanner.extract_model()`
  - `FDB_STRATEGY["aruba_cx"]` -> `ArubaCXScanner.fdb_strategy()`
  - Same pattern for FS, UniFi, OPNsense, Generic

  Example `backend/scanners/aruba_cx.py`:
  ```python
  import re
  from .base import VendorScanner

  _MODEL_ARUBA = re.compile(
      r"(Aruba(?:\s+CX)?\s+[\d]{4}[A-Za-z\-]*(?:\s+\d+[A-Za-z]+)?)",
      re.IGNORECASE,
  )
  _VIRTUAL = ("loopback", "vlan", "tunnel", "mgmt", "oobm")

  class ArubaCXScanner(VendorScanner):
      def extract_model(self, sys_descr: str) -> str:
          m = _MODEL_ARUBA.search(sys_descr)
          return m.group(1) if m else ""

      def is_virtual_port(self, if_descr: str) -> bool:
          return any(p in if_descr.lower() for p in _VIRTUAL)

      def fdb_strategy(self) -> str:
          return "dot1d"
  ```

- [ ] **Refactor `backend/snmp_scanner.py`** `scan_switch()` to use scanner registry:
  ```python
  from scanners import get_scanner

  async def scan_switch(...):
      ...
      vendor = detect_vendor(sys_descr, sys_oid)
      scanner = get_scanner(vendor)
      model = scanner.extract_model(sys_descr)
      ...
      # Use scanner.is_virtual_port() instead of is_virtual()
      # Use scanner.fdb_strategy() instead of FDB_STRATEGY[vendor]
  ```

- [ ] **Remove extracted code** from `snmp_scanner.py`: `_VIRTUAL_*` tuples, `_MODEL_*` regexes, `FDB_STRATEGY` dict, `is_virtual()`, `extract_model()` functions (replaced by scanner classes).

---

### 4.2 VLAN Discovery

**Complexity**: Moderate
**Dependencies**: Phase 1 complete, preferably after 4.1 (vendor plugin system) for clean integration
**New files**: None
**Modified files**: `backend/snmp_scanner.py`, `backend/scan_engine.py`, `frontend/src/components/Port.jsx`

#### Objective

Query SNMP VLAN tables (Q-BRIDGE-MIB `dot1qVlanStaticTable` and `dot1qPvid`) to populate the `Port.vlan` field that already exists in the database schema and UI components.

#### Checklist

- [ ] **Add VLAN OID constants to `backend/snmp_scanner.py`**
  ```python
  # Q-BRIDGE-MIB VLAN membership
  OID_DOT1Q_PVID            = "1.3.6.1.2.1.17.7.1.4.5.1.1"   # dot1qPvid: port -> PVID
  OID_DOT1Q_VLAN_STATIC_NAME = "1.3.6.1.2.1.17.7.1.4.3.1.1"  # dot1qVlanStaticName
  ```

- [ ] **Add VLAN to `SwitchData` dataclass** (already has `IfInfo` but no VLAN field):
  Add `vlan` field to `IfInfo` in `snmp_scanner.py` line 120:
  ```python
  @dataclass
  class IfInfo:
      index:       int
      descr:       str = ""
      alias:       str = ""
      speed_mbps:  int = 0
      oper_status: int = 2
      vlan:        int = 0  # <-- add this
  ```

- [ ] **Add VLAN walk to `scan_switch()`**

  After interface walk, add PVID walk:
  ```python
  # Walk PVID (port-based VLAN ID) via Q-BRIDGE-MIB
  pvid_rows = await snmp_bulk_walk(ip, port, auth, OID_DOT1Q_PVID, ...)
  bridge_port_pvid = {}
  for oid_str, val in pvid_rows:
      try:
          bridge_port = int(oid_str.split(".")[-1])
          vlan_id = int(val)
          bridge_port_pvid[bridge_port] = vlan_id
      except (ValueError, IndexError):
          continue

  # Map bridge port -> ifIndex using dot1dBasePortIfIndex (already walked)
  for bridge_port, vlan_id in bridge_port_pvid.items():
      ifindex = bp_to_ifindex.get(bridge_port)
      if ifindex and ifindex in interfaces:
          interfaces[ifindex].vlan = vlan_id
  ```

- [ ] **Update `backend/scan_engine.py`** port persistence (line ~780):

  In the port row construction, `vlan` is already included but sourced from the interface data. Verify it picks up the new `IfInfo.vlan`:
  ```python
  port_rows.append({
      ...
      "vlan": iface.vlan if hasattr(iface, 'vlan') else 0,
  })
  ```
  (Currently the field is 0 because `IfInfo` has no VLAN data populated -- this fix fills it.)

- [ ] **Update `frontend/src/components/Port.jsx`** -- VLAN is already rendered (line ~142: `{port.vlan > 0 && ...}`). No frontend change needed -- just verify it renders correctly.

---

### 4.3 Scan Cancellation Cleanup

**Complexity**: Simple
**Dependencies**: None
**New files**: None
**Modified files**: `backend/scan_engine.py`

#### Objective

When a scan is cancelled via the `cancel_event`, wrap the DB operations in a transaction that rolls back partial changes, so cancelled scans don't leave half-updated port or link data.

#### Checklist

- [ ] **Wrap `_execute_scan` DB writes in transaction blocks**

  In `backend/scan_engine.py`, the port update loop (starting around line 705) and link update section (starting around line 770) both call `db.commit()` per device. Change to batch commit with rollback on cancel:

  ```python
  if update_ports:
      try:
          for ip, sw in switch_data.items():
              if cancel_event and cancel_event.is_set():
                  db.rollback()
                  break
              # ... existing port update code ...
          else:
              db.commit()  # commit all port updates at once
      except Exception:
          db.rollback()
          raise
  ```

- [ ] **Same pattern for link updates** (line ~770):
  ```python
  if update_links:
      try:
          # ... existing link code ...
          if cancel_event and cancel_event.is_set():
              db.rollback()
          else:
              db.commit()
      except Exception:
          db.rollback()
          raise
  ```

- [ ] **Update `ScanRun` status** on cancellation to record that the run was partial:
  ```python
  if cancel_event and cancel_event.is_set():
      result.status = "cancelled"
      # Still persist the scan run to show partial results
  ```

---

## Phase 5: Frontend Improvements

---

### 5.1 Zustand State Management

**Complexity**: Moderate
**Dependencies**: None (but recommended after Phase 1 for consistent API error handling)
**New files**: `frontend/src/store.js`
**Modified files**: `frontend/package.json`, `frontend/src/hooks/useTopologyData.js`, `frontend/src/hooks/useMapBackground.js`, `frontend/src/hooks/useRackOrders.js`, `frontend/src/pages/MapPage.jsx`, `frontend/src/pages/DashboardPage.jsx`, `frontend/src/pages/SettingsPage.jsx`

#### Objective

Replace scattered `useState`/`localStorage`/`sessionStorage` with a centralized Zustand store for topology data, scan state, map settings, and UI preferences. This provides a single source of truth and simplifies data sharing across components.

#### Checklist

- [ ] **Add zustand to `frontend/package.json`**
  ```json
  "dependencies": {
    "zustand": "^4.5.0",
    ...
  }
  ```

- [ ] **Create `frontend/src/store.js`**
  ```javascript
  import { create } from "zustand";
  import { api } from "./api.js";

  export const useNetmapStore = create((set, get) => ({
    // Topology
    topology: { nodes: [], links: [], racks: [], classes: [], models: [] },
    selectedRack: null,
    topologyLoading: false,
    topologyError: null,

    loadTopology: async () => {
      set({ topologyLoading: true, topologyError: null });
      try {
        const data = await api.get("/api/topology");
        set({ topology: data, topologyLoading: false });
        return data;
      } catch (e) {
        set({ topologyError: e.message, topologyLoading: false });
      }
    },

    setSelectedRack: (rack) => set({ selectedRack: rack }),

    // Map background
    mapBgUrl: null,
    mapBgSettings: { opacity: 0.3, scale: 1.0, bg_color: "#020817" },
    loadMapBackground: async () => { ... },
    loadMapSettings: async () => { ... },

    // Scan state
    activeScanJobId: null,
    scanStatus: null,
    startScan: async () => { ... },

    // Rack orders (migrated from localStorage)
    rackOrders: JSON.parse(localStorage.getItem("netmap_rack_orders") || "{}"),
    setRackOrders: (orders) => {
      set({ rackOrders: orders });
      try { localStorage.setItem("netmap_rack_orders", JSON.stringify(orders)); } catch {}
    },
  }));
  ```

- [ ] **Refactor `frontend/src/hooks/useTopologyData.js`** to be a thin wrapper around the store:
  ```javascript
  import { useNetmapStore } from "../store.js";

  export function useTopologyData() {
    const topology = useNetmapStore(s => s.topology);
    const selectedRack = useNetmapStore(s => s.selectedRack);
    const setSelectedRack = useNetmapStore(s => s.setSelectedRack);
    const topologyError = useNetmapStore(s => s.topologyError);
    const loadTopology = useNetmapStore(s => s.loadTopology);
    return { topology, selectedRack, setSelectedRack, loadError: topologyError, loadTopology };
  }
  ```

- [ ] **Refactor `frontend/src/hooks/useMapBackground.js`** similarly.
- [ ] **Refactor `frontend/src/hooks/useRackOrders.js`** to read/write from store.
- [ ] **Update pages** (`MapPage.jsx`, `DashboardPage.jsx`, `SettingsPage.jsx`) to eliminate local topology/stats state that duplicates the store.

---

### 5.2 WebSocket Scan Progress

**Complexity**: Moderate
**Dependencies**: Phase 1 complete; item 3.1 (Redis) preferred for multi-worker broadcasting
**New files**: `backend/routers/ws.py`, `frontend/src/hooks/useScanProgress.js`
**Modified files**: `backend/main.py`, `backend/scan_engine.py`, `frontend/src/pages/DashboardPage.jsx`, `frontend/src/pages/SettingsPage.jsx`

#### Objective

Replace frontend polling (`setInterval` on scan job status) with real-time WebSocket updates for scan progress, completion, and log streaming.

#### Checklist

- [ ] **Create `backend/routers/ws.py`**
  ```python
  import asyncio
  import json
  from fastapi import APIRouter, WebSocket, WebSocketDisconnect
  from shared.state import get_scan_job, get_log_entries

  router = APIRouter()
  _connections: list[WebSocket] = []

  @router.websocket("/ws/scan-progress")
  async def scan_progress(ws: WebSocket):
      await ws.accept()
      _connections.append(ws)
      try:
          while True:
              data = await ws.receive_text()
              # Client can send job_id to subscribe
      except WebSocketDisconnect:
          _connections.remove(ws)

  async def broadcast_scan_update(data: dict):
      for ws in _connections[:]:
          try:
              await ws.send_json(data)
          except Exception:
              _connections.remove(ws)
  ```

- [ ] **Wire scan progress events** in `backend/scan_engine.py`:

  After each switch scan result in the `_execute_scan` gather loop, emit a progress event:
  ```python
  from routers.ws import broadcast_scan_update

  # Inside the result processing loop:
  progress = {
      "type": "scan_progress",
      "job_id": corr,
      "scanned": idx + 1,
      "total": len(scan_targets),
      "latest_ip": ip,
      "latest_success": bool(data),
  }
  # Schedule broadcast on the event loop
  asyncio.ensure_future(broadcast_scan_update(progress))
  ```

- [ ] **Create `frontend/src/hooks/useScanProgress.js`**
  ```javascript
  import { useState, useEffect, useRef } from "react";
  import { API } from "../api.js";

  export function useScanProgress(jobId) {
      const [progress, setProgress] = useState(null);
      const wsRef = useRef(null);

      useEffect(() => {
          if (!jobId) return;
          const wsUrl = `${API.replace("http", "ws")}/ws/scan-progress`;
          const ws = new WebSocket(wsUrl);
          ws.onmessage = (e) => setProgress(JSON.parse(e.data));
          ws.onclose = () => setProgress(null);
          wsRef.current = ws;
          return () => ws.close();
      }, [jobId]);

      return progress;
  }
  ```

- [ ] **Update `frontend/nginx.conf`** to proxy WebSocket:
  ```nginx
  location /ws/ {
      proxy_pass http://backend:8000/ws/;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_read_timeout 86400s;
  }
  ```

- [ ] **Update dashboard/settings scan UI** to use WebSocket progress instead of polling.

---

### 5.3 Port Endpoint Details UI

**Complexity**: Simple
**Dependencies**: None (data already exists in `endpoint_details_json` field)
**New files**: `frontend/src/components/PortDetailModal.jsx`
**Modified files**: `frontend/src/components/Port.jsx`, `frontend/src/components/map/RackDetail.jsx`

#### Objective

Add a modal that shows the full list of MAC/IP endpoints connected to a port. Currently the tooltip shows a truncated list; the modal allows scrolling through all entries with search/filter.

#### Checklist

- [ ] **Create `frontend/src/components/PortDetailModal.jsx`**
  ```javascript
  export default function PortDetailModal({ port, onClose }) {
    const [filter, setFilter] = useState("");
    const endpoints = (() => {
      try {
        const raw = port.endpoint_details_json;
        const value = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Array.isArray(value) ? value : [];
      } catch { return []; }
    })();

    const filtered = endpoints.filter(ep =>
      !filter || JSON.stringify(ep).toLowerCase().includes(filter.toLowerCase())
    );

    return (
      <div onClick={e => e.target === e.currentTarget && onClose()}
           style={{ position:"fixed", inset:0, zIndex:300, backgroundColor:"rgba(2,8,23,0.8)",
                    display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ width:600, maxHeight:"80vh", overflowY:"auto",
                      backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:12, padding:24 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:16 }}>
            <div>
              <div style={{ color:"#e2e8f0", fontSize:16, fontWeight:700 }}>
                Port {port.if_descr} - {endpoints.length} endpoint(s)
              </div>
              <div style={{ color:"#475569", fontSize:11 }}>
                VLAN {port.vlan || "untagged"} | Speed: {speedLabel(port.speed_mbps)}
              </div>
            </div>
            <button onClick={onClose}>X</button>
          </div>
          <input value={filter} onChange={e => setFilter(e.target.value)}
                 placeholder="Filter by MAC, IP, or hostname..." style={{...}} />
          <table>
            <thead><tr><th>MAC</th><th>IP</th><th>Hostname</th></tr></thead>
            <tbody>
              {filtered.map((ep, i) => (
                <tr key={i}>
                  <td>{ep.mac}</td>
                  <td>{ep.ip}</td>
                  <td>{ep.host}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  ```

- [ ] **Update `frontend/src/components/Port.jsx`**: Add double-click or shift-click handler to open the modal:
  ```javascript
  // In Port component, add:
  const [showModal, setShowModal] = useState(false);
  // On the port div, add:
  onDoubleClick={() => { if (hasDev) setShowModal(true); }}
  // Render modal:
  {showModal && <PortDetailModal port={port} onClose={() => setShowModal(false)} />}
  ```

---

## Phase 6: Observability & Operations

---

### 6.1 Prometheus Metrics

**Complexity**: Moderate
**Dependencies**: Phase 1 complete
**New files**: `backend/shared/metrics.py`
**Modified files**: `backend/requirements.txt`, `backend/main.py`, `backend/scan_engine.py`, `backend/routers/topology.py`

#### Objective

Expose a `/metrics` endpoint in Prometheus text format with key operational metrics: request latency, scan duration, device count, error count, active scans.

#### Checklist

- [ ] **Add `prometheus-client` to `backend/requirements.txt`**
  ```
  prometheus-client>=0.20.0
  ```

- [ ] **Create `backend/shared/metrics.py`**
  ```python
  from prometheus_client import Counter, Histogram, Gauge, Info

  SCAN_DURATION = Histogram("netmap_scan_duration_seconds", "Scan execution duration", ["scan_type"])
  SCAN_TOTAL = Counter("netmap_scans_total", "Total number of scans", ["scan_type", "status"])
  SCAN_ACTIVE = Gauge("netmap_scans_active", "Currently running scans")
  DEVICE_COUNT = Gauge("netmap_devices_total", "Total discovered devices")
  PORT_COUNT = Gauge("netmap_ports_total", "Total ports", ["status"])
  REQUEST_LATENCY = Histogram("netmap_request_duration_seconds", "HTTP request duration", ["method", "endpoint"])
  REQUEST_TOTAL = Counter("netmap_requests_total", "Total HTTP requests", ["method", "endpoint", "status"])
  ```

- [ ] **Add metrics middleware to `backend/main.py`**
  ```python
  import time
  from starlette.middleware.base import BaseHTTPMiddleware
  from shared.metrics import REQUEST_LATENCY, REQUEST_TOTAL

  class MetricsMiddleware(BaseHTTPMiddleware):
      async def dispatch(self, request, call_next):
          start = time.perf_counter()
          response = await call_next(request)
          duration = time.perf_counter() - start
          endpoint = request.url.path
          REQUEST_LATENCY.labels(method=request.method, endpoint=endpoint).observe(duration)
          REQUEST_TOTAL.labels(method=request.method, endpoint=endpoint, status=response.status_code).inc()
          return response

  app.add_middleware(MetricsMiddleware)
  ```

- [ ] **Add `/metrics` endpoint** (exempt from auth):
  ```python
  from prometheus_client import generate_latest, CONTENT_TYPE_LATEST

  @app.get("/metrics", include_in_schema=False)
  def metrics():
      return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
  ```
  Add `/metrics` to `_AUTH_EXEMPT_PATHS` in `backend/shared/auth.py`.

- [ ] **Instrument scan engine** in `backend/scan_engine.py`:
  ```python
  from shared.metrics import SCAN_DURATION, SCAN_TOTAL, SCAN_ACTIVE

  # At scan start:
  SCAN_ACTIVE.inc()
  # At scan end:
  SCAN_ACTIVE.dec()
  SCAN_DURATION.labels(scan_type=scan_mode).observe(total_duration_ms / 1000)
  SCAN_TOTAL.labels(scan_type=scan_mode, status=status).inc()
  ```

- [ ] **Update device/port counts** after each scan:
  ```python
  from shared.metrics import DEVICE_COUNT, PORT_COUNT
  DEVICE_COUNT.set(db.query(Device).count())
  PORT_COUNT.labels(status="up").set(db.query(Port).filter(Port.oper_status == 1).count())
  PORT_COUNT.labels(status="down").set(db.query(Port).filter(Port.oper_status == 2).count())
  ```

---

### 6.2 CI/CD Pipeline

**Complexity**: Simple
**Dependencies**: Item 1.4 (test infrastructure)
**New files**: `.github/workflows/ci.yml` (expand the one created in 1.4)
**Modified files**: None (just CI config)

#### Objective

Full CI/CD pipeline: lint (ruff + eslint), test, build Docker images, push to registry on tag.

#### Checklist

- [ ] **Expand `.github/workflows/ci.yml`**
  ```yaml
  name: CI/CD
  on:
    push:
      branches: [main]
      tags: ['v*']
    pull_request:
      branches: [main]

  jobs:
    lint-backend:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-python@v5
          with: { python-version: "3.12" }
        - run: pip install ruff
        - run: ruff check backend/

    lint-frontend:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: "20" }
        - run: cd frontend && npm ci
        - run: cd frontend && npx eslint src/ --ext .js,.jsx

    test-backend:
      runs-on: ubuntu-latest
      needs: lint-backend
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-python@v5
          with: { python-version: "3.12" }
        - run: pip install -r backend/requirements.txt
        - run: pip install pytest pytest-asyncio httpx
        - run: cd backend && python -m pytest tests/ -v
          env:
            DATABASE_URL: "sqlite:///./test.db"
            SECRET_TOKEN: "test-token"

    test-frontend:
      runs-on: ubuntu-latest
      needs: lint-frontend
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: "20" }
        - run: cd frontend && npm ci
        - run: cd frontend && npm test

    docker-build:
      runs-on: ubuntu-latest
      needs: [test-backend, test-frontend]
      if: github.event_name == 'push'
      steps:
        - uses: actions/checkout@v4
        - uses: docker/setup-buildx-action@v3
        - run: docker compose build

    docker-push:
      runs-on: ubuntu-latest
      needs: docker-build
      if: startsWith(github.ref, 'refs/tags/v')
      steps:
        - uses: actions/checkout@v4
        - uses: docker/login-action@v3
          with:
            registry: ghcr.io
            username: ${{ github.actor }}
            password: ${{ secrets.GITHUB_TOKEN }}
        - run: |
            TAG=${GITHUB_REF#refs/tags/}
            docker compose build
            docker tag netmap-backend ghcr.io/${{ github.repository }}/backend:$TAG
            docker tag netmap-frontend ghcr.io/${{ github.repository }}/frontend:$TAG
            docker push ghcr.io/${{ github.repository }}/backend:$TAG
            docker push ghcr.io/${{ github.repository }}/frontend:$TAG
  ```

- [ ] **Add `ruff` config to `backend/pyproject.toml`** (new file):
  ```toml
  [tool.ruff]
  line-length = 120
  target-version = "py312"

  [tool.ruff.lint]
  select = ["E", "W", "F", "I"]
  ignore = ["E501"]
  ```

---

## Phase 7: Remaining Items

---

### 7.1 Credential Fallback Chains

**Complexity**: Moderate
**Dependencies**: Phase 1 complete
**New files**: `backend/alembic/versions/008_credential_fallback.py`
**Modified files**: `backend/database.py`, `backend/schemas.py`, `backend/scan_engine.py`, `backend/routers/credentials.py`, `frontend/src/components/settings/CredentialsTab.jsx`

#### Objective

Allow multiple credentials per IP address so that if the primary profile fails, the scanner automatically tries the next one. Currently, `Credential.ip` has a `unique=True` constraint enforcing one credential per IP.

#### Checklist

- [ ] **Add `priority` column to `Credential` model** in `backend/database.py`:
  ```python
  priority = Column(Integer, default=0)  # lower = tried first
  ```

- [ ] **Remove `unique=True` from `Credential.ip`** and add a composite unique on `(ip, priority)`:
  ```python
  ip = Column(String, nullable=False, index=True)  # remove unique=True
  __table_args__ = (UniqueConstraint("ip", "priority", name="uq_credential_ip_priority"),)
  ```

- [ ] **Create migration `008_credential_fallback.py`**
  - Drop unique index on `ip`
  - Add `priority` column with default 0
  - Add composite unique index on `(ip, priority)`

- [ ] **Update `backend/scan_engine.py`** credential loading:
  ```python
  # Before: one credential per IP
  credentials = db.query(Credential).filter(Credential.enabled == True).all()

  # After: group by IP, ordered by priority
  from collections import defaultdict
  all_creds = db.query(Credential).filter(Credential.enabled == True).order_by(Credential.ip, Credential.priority).all()
  creds_by_ip = defaultdict(list)
  for c in all_creds:
      creds_by_ip[c.ip].append(c)
  ```

  In `_scan_target_async`, try each credential in order:
  ```python
  for cred in creds_by_ip[ip]:
      try:
          data = await scan_switch(ip=ip, ...)
          if data:
              break
      except Exception:
          continue
  ```

- [ ] **Update `backend/routers/credentials.py`**:
  - `create_credential`: Change duplicate IP check from error to allow with different priority
  - Add `priority` field to create/update schemas

- [ ] **Update `backend/schemas.py`**: Add `priority: int = 0` to `CredentialBase`, `CredentialCreate`, `CredentialUpdate`, `CredentialOut`

- [ ] **Update frontend `CredentialsTab.jsx`**: Add priority field to form, show credential ordering per IP

---

### 7.2 Bulk Device Operations

**Complexity**: Simple
**Dependencies**: Phase 1 complete
**New files**: None
**Modified files**: `backend/routers/topology.py`, `backend/schemas.py`, `frontend/src/components/settings/DevicesTab.jsx`

#### Objective

Add multi-select ignore/unignore in the settings Devices tab and a backend endpoint for bulk device meta updates.

#### Checklist

- [ ] **Add bulk meta update endpoint** in `backend/routers/topology.py`:
  ```python
  class BulkDeviceMetaUpdate(BaseModel):
      device_ids: List[int]
      ignored: Optional[bool] = None
      rack_id: Optional[int] = None
      class_id: Optional[int] = None

  @router.patch("/api/topology/devices/bulk-meta")
  def bulk_update_device_meta(body: BulkDeviceMetaUpdate, db: Session = Depends(get_db)):
      updates = {}
      if body.ignored is not None:
          updates["ignored"] = body.ignored
      if body.rack_id is not None:
          updates["rack_id"] = body.rack_id
      if body.class_id is not None:
          updates["class_id"] = body.class_id
      if not updates:
          raise HTTPException(400, "No fields to update")
      count = db.query(Device).filter(Device.id.in_(body.device_ids)).update(updates, synchronize_session="fetch")
      db.commit()
      _bump_topo_version()
      return {"updated": count}
  ```

- [ ] **Add `BulkDeviceMetaUpdate` schema** to `backend/schemas.py`

- [ ] **Update `frontend/src/components/settings/DevicesTab.jsx`**:

  Add selection state and bulk action bar:
  ```javascript
  const [selected, setSelected] = useState(new Set());

  const toggleSelect = (id) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectAll = (devs) => setSelected(new Set(devs.map(d => d.id)));

  const bulkIgnore = async (ignored) => {
    await api.patch("/api/topology/devices/bulk-meta", {
      device_ids: [...selected], ignored
    });
    setSelected(new Set());
    api.invalidate("/api/topology", "/api/devices");
    refresh();
  };
  ```

  Add checkbox to each device row and a "Bulk Actions" toolbar:
  ```javascript
  // Toolbar
  {selected.size > 0 && (
    <div style={{...}}>
      <span>{selected.size} selected</span>
      <button onClick={() => bulkIgnore(true)}>Ignore Selected</button>
      <button onClick={() => bulkIgnore(false)}>Re-enable Selected</button>
      <button onClick={() => setSelected(new Set())}>Clear Selection</button>
    </div>
  )}

  // Per-row checkbox (in renderDevice):
  <input type="checkbox" checked={selected.has(dev.id)}
         onChange={() => toggleSelect(dev.id)} />
  ```

---

### 7.3 Dry-Run Persistence

**Complexity**: Simple
**Dependencies**: None
**New files**: None
**Modified files**: `backend/scan_engine.py`, `backend/database.py`, `backend/schemas.py`

#### Objective

Save dry-run scan results to the database so they can be reviewed later without re-running. Currently, dry-run results are returned in the job response but not persisted.

#### Checklist

- [ ] **Add `DryRunResult` model to `backend/database.py`**
  ```python
  class DryRunResult(Base):
      __tablename__ = "dry_run_results"

      id          = Column(Integer, primary_key=True, index=True)
      scan_run_id = Column(Integer, ForeignKey("scan_runs.id"), nullable=True)
      preview_json = Column(JSONB, default=[])
      created_at  = Column(DateTime, server_default=func.now())
  ```

- [ ] **Create Alembic migration** for `dry_run_results` table

- [ ] **Update `backend/scan_engine.py`** dry-run block (around line 615):
  ```python
  if dry_run:
      # ... existing preview construction ...
      # Persist the dry-run result
      run = _persist_scan_run(db, result, [], [])
      dry_run_record = DryRunResult(
          scan_run_id=run,
          preview_json=dry_run_preview,
      )
      db.add(dry_run_record)
      db.commit()
      result.run_id = run
  ```

- [ ] **Add dry-run results endpoint**:
  ```python
  @router.get("/api/scan-runs/{run_id}/dry-run-preview")
  def get_dry_run_preview(run_id: int, db: Session = Depends(get_db)):
      record = db.query(DryRunResult).filter(DryRunResult.scan_run_id == run_id).first()
      if not record:
          raise HTTPException(404, "Dry-run preview not found")
      return record.preview_json
  ```

- [ ] **Add schema** for dry-run output to `backend/schemas.py`:
  ```python
  class DryRunPreviewItem(BaseModel):
      ip: str
      sys_name: str = ""
      vendor: str = "generic"
      matched_profile_id: Optional[int] = None
      already_exists: bool = False
  ```

---

## Summary: Implementation Order and Dependencies

```
Phase 1 (Foundation) - All 4 items can be worked in parallel
  |
  +-- 1.1 Structured Error Responses
  +-- 1.2 Comprehensive Input Validation
  +-- 1.3 Consolidate Settings into Database (depends on 1.2)
  +-- 1.4 Test Infrastructure Setup
  |
Phase 2 (Security) - Requires Phase 1
  |
  +-- 2.1 RBAC (depends on 1.1)
  +-- 2.2 Audit Trail (depends on 2.1)
  |
Phase 3 (Scalability) - Requires Phase 1
  |
  +-- 3.1 Redis State Migration
  +-- 3.2 Celery Background Queue (depends on 3.1)
  |
Phase 4 (Scanner) - Requires Phase 1
  |
  +-- 4.1 Vendor Plugin System
  +-- 4.2 VLAN Discovery (benefits from 4.1)
  +-- 4.3 Scan Cancellation Cleanup
  |
Phase 5 (Frontend) - Can start after Phase 1
  |
  +-- 5.1 Zustand State Management
  +-- 5.2 WebSocket Scan Progress (benefits from 3.1)
  +-- 5.3 Port Endpoint Details UI
  |
Phase 6 (Observability) - Requires Phase 1
  |
  +-- 6.1 Prometheus Metrics
  +-- 6.2 CI/CD Pipeline (depends on 1.4)
  |
Phase 7 (Remaining) - Can be done at any time after Phase 1
  |
  +-- 7.1 Credential Fallback Chains
  +-- 7.2 Bulk Device Operations
  +-- 7.3 Dry-Run Persistence
```

## File Change Summary

### New Files (21)

| File | Item |
|------|------|
| `backend/shared/errors.py` | 1.1 |
| `backend/alembic/versions/005_settings_to_db.py` | 1.3 |
| `backend/tests/__init__.py` | 1.4 |
| `backend/tests/conftest.py` | 1.4 |
| `backend/tests/test_health.py` | 1.4 |
| `backend/tests/test_credentials.py` | 1.4 |
| `backend/tests/test_schemas.py` | 1.4 |
| `frontend/vitest.config.js` | 1.4 |
| `frontend/src/__tests__/api.test.js` | 1.4 |
| `.github/workflows/ci.yml` | 1.4 / 6.2 |
| `backend/alembic/versions/006_add_users_table.py` | 2.1 |
| `backend/routers/auth.py` | 2.1 |
| `backend/alembic/versions/007_add_audit_log.py` | 2.2 |
| `backend/shared/audit.py` | 2.2 |
| `backend/shared/redis_client.py` | 3.1 |
| `backend/celery_app.py` | 3.2 |
| `backend/tasks.py` | 3.2 |
| `backend/scanners/__init__.py` | 4.1 |
| `backend/scanners/base.py` | 4.1 |
| `backend/scanners/aruba_cx.py` | 4.1 |
| `backend/scanners/fs_scanner.py` | 4.1 |
| `backend/scanners/unifi.py` | 4.1 |
| `backend/scanners/opnsense.py` | 4.1 |
| `backend/scanners/generic.py` | 4.1 |
| `frontend/src/store.js` | 5.1 |
| `backend/routers/ws.py` | 5.2 |
| `frontend/src/hooks/useScanProgress.js` | 5.2 |
| `frontend/src/components/PortDetailModal.jsx` | 5.3 |
| `backend/shared/metrics.py` | 6.1 |
| `backend/pyproject.toml` | 6.2 |
| `backend/alembic/versions/008_credential_fallback.py` | 7.1 |

### Heavily Modified Files

| File | Items |
|------|-------|
| `backend/schemas.py` | 1.1, 1.2, 2.1, 2.2, 7.1, 7.2, 7.3 |
| `backend/main.py` | 1.1, 2.1, 3.1, 5.2, 6.1 |
| `backend/database.py` | 1.3, 2.1, 2.2, 7.1, 7.3 |
| `backend/scan_engine.py` | 3.1, 3.2, 4.1, 4.2, 4.3, 5.2, 6.1, 7.1 |
| `backend/snmp_scanner.py` | 4.1, 4.2 |
| `backend/shared/auth.py` | 1.1, 2.1, 6.1 |
| `backend/shared/state.py` | 3.1 |
| `backend/shared/file_settings.py` | 1.3 |
| `backend/requirements.txt` | 1.4, 2.1, 3.1, 3.2, 6.1 |
| `docker-compose.yml` | 3.1, 3.2 |
| `frontend/package.json` | 1.4, 5.1 |
| `frontend/src/api.js` | 1.1 |
| All `backend/routers/*.py` | 1.1, 1.2, 2.1, 2.2 |

### Complexity Summary

| Complexity | Count | Items |
|------------|-------|-------|
| Simple | 6 | 4.3, 5.3, 6.2, 7.2, 7.3 |
| Moderate | 8 | 1.1, 1.2, 1.4, 2.2, 4.2, 5.1, 5.2, 6.1 |
| Complex | 5 | 1.3, 2.1, 3.1, 3.2, 4.1, 7.1 |
