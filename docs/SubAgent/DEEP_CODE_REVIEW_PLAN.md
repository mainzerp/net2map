# Deep Code Review - Implementation Plan

**Source**: [DEEP_CODE_REVIEW_ANALYSIS.md](DEEP_CODE_REVIEW_ANALYSIS.md)
**Created**: 2026-03-08
**Total Issues**: 35 (5 Critical, 8 High, 12 Medium, 10 Low)

---

## Phase 1 - Critical Security & Bug Fixes (Must-Fix)

### 1.1 CRIT-02: Require Non-Empty SECRET_TOKEN at Startup
**Ref**: CRIT-02 | **Complexity**: Simple | **Quick Win**: Yes
**Files**: [backend/shared/auth.py](../../backend/shared/auth.py), [docker-compose.yml](../../docker-compose.yml)

**Problem**: `SECRET_TOKEN` defaults to empty string, which disables all authentication. The docker-compose.yml ships with `SECRET_TOKEN: ""`.

**Steps**:
- [ ] In `backend/shared/auth.py`, add a startup-time check that logs a warning when `SECRET_TOKEN` is empty. Optionally fail fast in production mode.
- [ ] In `docker-compose.yml`, change `SECRET_TOKEN: ""` to `SECRET_TOKEN: "changeme"` with a comment instructing users to replace it.
- [ ] Add a log warning at import time if `SECRET_TOKEN` is empty:
  ```python
  import logging
  _log = logging.getLogger(__name__)
  SECRET_TOKEN = os.getenv("SECRET_TOKEN", "")
  if not SECRET_TOKEN:
      _log.warning("SECRET_TOKEN is not set -- API authentication is DISABLED")
  ```

---

### 1.2 CRIT-05: Remove Hardcoded Database Password from docker-compose.yml
**Ref**: CRIT-05 | **Complexity**: Simple | **Quick Win**: Yes
**Files**: [docker-compose.yml](../../docker-compose.yml)

**Problem**: `POSTGRES_PASSWORD: netmap_pw` is hardcoded in version control.

**Steps**:
- [ ] Create a `.env.example` file with placeholder values:
  ```env
  POSTGRES_PASSWORD=changeme
  SECRET_TOKEN=changeme
  ```
- [ ] Update `docker-compose.yml` to reference env vars:
  ```yaml
  environment:
    POSTGRES_DB: netmap
    POSTGRES_USER: netmap
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-netmap_pw}
  ```
  And for the backend:
  ```yaml
  DATABASE_URL: "postgresql://netmap:${POSTGRES_PASSWORD:-netmap_pw}@postgres/netmap"
  SECRET_TOKEN: "${SECRET_TOKEN:-changeme}"
  ```
- [ ] Add `.env` to `.gitignore` (keep `.env.example` tracked).
- [ ] Update `README.md` to document the `.env` setup.

---

### 1.3 CRIT-03: Redact Passwords in Bulk/Config Export
**Ref**: CRIT-03 | **Complexity**: Simple | **Quick Win**: Yes
**Files**: [backend/routers/bulk.py](../../backend/routers/bulk.py), [backend/routers/config.py](../../backend/routers/config.py)

**Problem**: Export endpoints expose `v3_auth_password` and `v3_priv_password` in plaintext.

**Steps**:
- [ ] In `backend/routers/config.py`, mask password fields in the export payload. Replace raw password values with `"********"` or omit them:
  ```python
  "v3_auth_password": "********" if p.v3_auth_password else "",
  "v3_priv_password": "********" if p.v3_priv_password else "",
  ```
  Apply the same pattern for credentials in the same file.
- [ ] In `backend/routers/bulk.py`, apply the same redaction when building export rows. In the list comprehension or dict construction that reads from the model, mask password fields before writing to CSV/JSON output.
- [ ] Verify that import endpoints still accept actual passwords (import should work; export should not leak).

---

### 1.4 CRIT-04: Sanitize SVG Uploads (XSS/XXE Prevention)
**Ref**: CRIT-04 | **Complexity**: Moderate | **Quick Win**: No
**Files**: [backend/routers/map_bg.py](../../backend/routers/map_bg.py), [backend/requirements.txt](../../backend/requirements.txt)

**Problem**: SVG uploads pass through without content validation, allowing `<script>` tags, event handlers, and XXE declarations.

**Steps**:
- [ ] Add `defusedxml` to `backend/requirements.txt`.
- [ ] Create an SVG sanitizer function in `backend/routers/map_bg.py`:
  ```python
  import re
  from defusedxml import ElementTree as SafeET

  def _sanitize_svg(raw: bytes) -> bytes:
      """Strip script tags, event handlers, and external entities from SVG."""
      SafeET.fromstring(raw)  # raises on XXE / malformed XML
      text = raw.decode("utf-8", errors="replace")
      text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL | re.IGNORECASE)
      text = re.sub(r'\s+on\w+\s*=\s*"[^"]*"', "", text, flags=re.IGNORECASE)
      text = re.sub(r'\s+on\w+\s*=\s*\'[^\']*\'', "", text, flags=re.IGNORECASE)
      return text.encode("utf-8")
  ```
- [ ] Call `_sanitize_svg(contents)` in the upload endpoint when `ext == ".svg"`, and save the sanitized output.
- [ ] Wrap the sanitization in a try/except and return HTTP 400 on parse failure.

---

### 1.5 CRIT-01: Encrypt SNMP Passwords at Rest
**Ref**: CRIT-01 | **Complexity**: Complex | **Quick Win**: No
**Files**: [backend/database.py](../../backend/database.py), [backend/snmp_scanner.py](../../backend/snmp_scanner.py), [backend/routers/credentials.py](../../backend/routers/credentials.py), [backend/routers/snmp_profiles.py](../../backend/routers/snmp_profiles.py), [backend/routers/config.py](../../backend/routers/config.py), [backend/routers/bulk.py](../../backend/routers/bulk.py), [backend/requirements.txt](../../backend/requirements.txt)

**Problem**: `v3_auth_password` and `v3_priv_password` are stored as plaintext `String` columns.

**Steps**:
- [ ] Add `cryptography` to `backend/requirements.txt`.
- [ ] Create a `backend/shared/crypto.py` utility:
  ```python
  import os
  from cryptography.fernet import Fernet

  _KEY = os.getenv("ENCRYPTION_KEY", "")
  if not _KEY:
      import logging
      logging.getLogger(__name__).warning("ENCRYPTION_KEY not set -- passwords stored unencrypted")

  _fernet = Fernet(_KEY.encode()) if _KEY else None

  def encrypt(value: str) -> str:
      if not value or not _fernet:
          return value
      return _fernet.encrypt(value.encode()).decode()

  def decrypt(value: str) -> str:
      if not value or not _fernet:
          return value
      try:
          return _fernet.decrypt(value.encode()).decode()
      except Exception:
          return value  # fallback for unencrypted legacy values
  ```
- [ ] Add `ENCRYPTION_KEY` to `.env.example` and `docker-compose.yml`.
- [ ] In credential/profile CRUD routers, encrypt passwords before saving to DB and decrypt when reading for SNMP operations.
- [ ] In `backend/snmp_scanner.py`, decrypt passwords at scan time before passing to pysnmp.
- [ ] Create an Alembic migration that re-encrypts existing plaintext passwords (run-once script).
- [ ] Update `.env.example` with instructions to generate a Fernet key: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.

---

### 1.6 BUG-01: Port Status Count Compares Integer to String
**Ref**: BUG-01 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [backend/routers/settings.py](../../backend/routers/settings.py) (line ~40)

**Problem**: `Port.oper_status == "up"` always returns 0 because `oper_status` is an Integer column (1=up, 2=down).

**Steps**:
- [ ] Change line in `get_stats()`:
  ```python
  # Before:
  port_up = db.query(Port).filter(Port.oper_status == "up").count()
  # After:
  port_up = db.query(Port).filter(Port.oper_status == 1).count()
  ```

---

### 1.7 BUG-05: Replace Deprecated imghdr Module
**Ref**: BUG-05 | **Complexity**: Simple | **Quick Win**: Yes
**Files**: [backend/routers/map_bg.py](../../backend/routers/map_bg.py), [backend/requirements.txt](../../backend/requirements.txt)

**Problem**: `imghdr` is removed in Python 3.13. App will crash on upload.

**Steps**:
- [ ] Add `filetype` to `backend/requirements.txt`.
- [ ] Replace `imghdr` usage in `map_bg.py`:
  ```python
  # Before:
  import imghdr
  detected = imghdr.what(None, h=contents)

  # After:
  import filetype
  kind = filetype.guess(contents)
  detected = kind.extension if kind else None
  ```
- [ ] Update the validation check to compare against the new detection output (e.g., `"png"`, `"jpg"`, `"gif"`, `"webp"`).
- [ ] Update `ALLOWED_IMAGE_TYPES` in `file_settings.py` if needed to match the new library's output format.

---

### 1.8 SEC-01: Add Rate Limiting on API Endpoints
**Ref**: SEC-01 | **Complexity**: Moderate | **Quick Win**: No
**Files**: [backend/main.py](../../backend/main.py), [backend/requirements.txt](../../backend/requirements.txt)

**Problem**: No rate limiting allows DoS via rapid scan triggers and brute-force token guessing.

**Steps**:
- [ ] Add `slowapi` to `backend/requirements.txt`.
- [ ] Configure rate limiting in `backend/main.py`:
  ```python
  from slowapi import Limiter, _rate_limit_exceeded_handler
  from slowapi.util import get_remote_address
  from slowapi.errors import RateLimitExceeded

  limiter = Limiter(key_func=get_remote_address)
  app.state.limiter = limiter
  app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
  ```
- [ ] Apply rate limits to sensitive endpoints:
  - `POST /api/scan/jobs` - e.g., `5/minute`
  - `POST /api/scan` - e.g., `2/minute`
  - `GET /api/bulk-export/*` - e.g., `10/minute`
  - `GET /api/config/export` - e.g., `10/minute`
- [ ] Add `@limiter.limit("5/minute")` decorators to the relevant route handler functions.

---

### 1.9 SEC-02: Add Security Headers in Nginx
**Ref**: SEC-02 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [frontend/nginx.conf](../../frontend/nginx.conf)

**Problem**: Missing standard security headers.

**Steps**:
- [ ] Add security headers inside the `server` block in `nginx.conf`:
  ```nginx
  # Security headers
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-XSS-Protection "1; mode=block" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  ```

---

### 1.10 FE-06: Commit package-lock.json and Use npm ci
**Ref**: FE-06 | **Complexity**: Simple | **Quick Win**: Yes
**Files**: [frontend/Dockerfile](../../frontend/Dockerfile), `frontend/package-lock.json` (to be generated)

**Problem**: No lockfile means non-reproducible builds.

**Steps**:
- [ ] Run `npm install` in `frontend/` to generate `package-lock.json`.
- [ ] Commit `package-lock.json` to the repository.
- [ ] Update `frontend/Dockerfile` to use `npm ci` instead of `npm install`:
  ```dockerfile
  COPY package.json package-lock.json ./
  RUN npm ci
  ```

---

### 1.11 DK-03: Add Backend Healthcheck in docker-compose.yml
**Ref**: DK-03 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [docker-compose.yml](../../docker-compose.yml)

**Problem**: The analysis states no healthcheck exists, but reviewing the file shows one is already present. Verify it works correctly.

**Steps**:
- [ ] Verify the existing healthcheck at the `/health` endpoint path matches the router path (currently `/api/health`).
- [ ] If the healthcheck URL is wrong, fix it to match the actual endpoint: `http://localhost:8000/api/health`.
- [ ] Ensure `backend/routers/health.py` returns a 200 response for the health path.

---

## Phase 2 - Medium Priority Improvements

### 2.1 Bug Fixes (Medium)

#### 2.1.1 BUG-02: Add Missing 25G and 40G Speed Labels
**Ref**: BUG-02 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [frontend/src/api.js](../../frontend/src/api.js)

- [ ] Update the `speedLabel` function to include 25G and 40G tiers:
  ```javascript
  export const speedLabel = mbps =>
    mbps >= 100000 ? "100G" :
    mbps >= 40000  ? "40G"  :
    mbps >= 25000  ? "25G"  :
    mbps >= 10000  ? "10G"  :
    mbps >= 1000   ? "1G"   :
    mbps >= 100    ? "100M" :
    mbps > 0       ? "10M"  : "?";
  ```
- [ ] Update `speedColor` if needed to include colors for the new tiers.

#### 2.1.2 BUG-03: Fix Double API Call on Topology Mount
**Ref**: BUG-03 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [frontend/src/hooks/useTopologyData.js](../../frontend/src/hooks/useTopologyData.js)

- [ ] Remove the duplicate `api.get("/api/topology")` call inside the `useEffect`. Use `loadTopology()` instead and handle the sessionStorage restore inside the `.then()` callback of `loadTopology`, or refactor `loadTopology` to accept an optional callback for post-load processing.
- [ ] Alternative: remove the standalone `loadTopology()` definition and inline all logic in the `useEffect`:
  ```javascript
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    api.get("/api/topology").then(data => {
      setTopology(data);
      // restore selectedRack from sessionStorage
      const savedId = sessionStorage.getItem("selectedRackId");
      if (savedId) {
        const id = Number(savedId);
        const rack = (data.racks || []).find(r => r.id === id);
        if (rack) { /* ... */ }
      }
    }).catch(e => setLoadError(e.message));
  }, []);
  ```

---

### 2.2 Deprecation Fixes

#### 2.2.1 CQ-01: Migrate to FastAPI Lifespan Pattern
**Ref**: CQ-01 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [backend/main.py](../../backend/main.py)

- [ ] Replace `@app.on_event("startup")` with lifespan context manager:
  ```python
  from contextlib import asynccontextmanager

  @asynccontextmanager
  async def lifespan(app: FastAPI):
      # startup logic here
      yield
      # shutdown logic here (if any)

  app = FastAPI(lifespan=lifespan)
  ```
- [ ] Move all code from the existing startup handler into the lifespan `yield` block's pre-yield section.

#### 2.2.2 CQ-02: Replace Deprecated datetime.utcnow()
**Ref**: CQ-02 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [backend/database.py](../../backend/database.py)

- [ ] Replace all `datetime.utcnow` references with `func.now()` (server-side) for column defaults:
  ```python
  from sqlalchemy import func
  # Before:
  created_at = Column(DateTime, default=datetime.utcnow)
  updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
  # After:
  created_at = Column(DateTime, server_default=func.now())
  updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
  ```
- [ ] Search the entire backend for other uses of `datetime.utcnow()` and replace with `datetime.now(datetime.timezone.utc)`.

---

### 2.3 Security (Medium)

#### 2.3.1 SEC-03: Validate CORS_ORIGIN
**Ref**: SEC-03 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [backend/main.py](../../backend/main.py)

- [ ] Add basic validation that `CORS_ORIGIN` is a valid URL and not `*`:
  ```python
  CORS_ORIGIN = os.getenv("CORS_ORIGIN", "http://localhost:5173")
  if CORS_ORIGIN == "*":
      import logging
      logging.getLogger(__name__).warning("CORS_ORIGIN is set to '*' -- this is insecure")
  ```

#### 2.3.2 SEC-05: Fix Missing Auth Headers on Frontend Direct Fetch
**Ref**: SEC-05 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [frontend/src/hooks/useMapBackground.js](../../frontend/src/hooks/useMapBackground.js)

- [ ] Replace direct `fetch(url)` calls with `api.get()` or include the auth header:
  ```javascript
  // Use the api helper instead of raw fetch
  import { api, API } from "../api.js";
  ```

---

### 2.4 Infrastructure & Reliability

#### 2.4.1 CQ-03: Enforce Single-Worker Constraint
**Ref**: CQ-03 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [backend/main.py](../../backend/main.py) or [backend/shared/state.py](../../backend/shared/state.py)

- [ ] Add a startup check or ensure the uvicorn command in `entrypoint.sh` explicitly sets `--workers 1`.
- [ ] Log a message at startup confirming single-worker mode.

#### 2.4.2 CQ-04: Add File Locking for Settings I/O
**Ref**: CQ-04 | **Complexity**: Simple | **Quick Win**: No
**File**: [backend/shared/file_settings.py](../../backend/shared/file_settings.py)

- [ ] Add `portalocker` to `backend/requirements.txt`.
- [ ] Wrap file read/write operations with file locking:
  ```python
  import portalocker

  def _read_json(path):
      with open(path, "r") as f:
          portalocker.lock(f, portalocker.LOCK_SH)
          return json.load(f)

  def _write_json(path, data):
      with open(path, "w") as f:
          portalocker.lock(f, portalocker.LOCK_EX)
          json.dump(data, f)
  ```

#### 2.4.3 DB-01: Fail Fast on Missing DATABASE_URL in Alembic
**Ref**: DB-01 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [backend/alembic/env.py](../../backend/alembic/env.py)

- [ ] Replace the silent fallback with an explicit check:
  ```python
  db_url = os.getenv("DATABASE_URL")
  if not db_url:
      raise RuntimeError("DATABASE_URL environment variable is required for migrations")
  ```

#### 2.4.4 DK-01: Add Docker Resource Limits
**Ref**: DK-01 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [docker-compose.yml](../../docker-compose.yml)

- [ ] Add resource limits to each service:
  ```yaml
  backend:
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
  ```

#### 2.4.5 DK-04: Document TLS Configuration
**Ref**: DK-04 | **Complexity**: Moderate | **Quick Win**: No
**File**: [frontend/nginx.conf](../../frontend/nginx.conf), [README.md](../../README.md)

- [ ] Add a section in `README.md` documenting how to set up TLS (reverse proxy with Traefik/Caddy or nginx TLS).
- [ ] Optionally add an `nginx-ssl.conf.example` with TLS configuration template.

---

### 2.5 Performance (Medium)

#### 2.5.1 PERF-03: Optimize ETag Computation
**Ref**: PERF-03 | **Complexity**: Moderate | **Quick Win**: No
**File**: [backend/routers/topology.py](../../backend/routers/topology.py)

- [ ] Add a version counter or last-modified timestamp that increments on topology changes.
- [ ] Check If-None-Match before building the full payload. Only serialize when ETag mismatch.
- [ ] Alternative: cache the serialized payload and invalidate on DB writes.

#### 2.5.2 PERF-01: Reuse Event Loop in Scan Engine
**Ref**: PERF-01 | **Complexity**: Moderate | **Quick Win**: No
**File**: [backend/scan_engine.py](../../backend/scan_engine.py)

- [ ] Create a single background event loop in a daemon thread at module level.
- [ ] Submit scan coroutines to the shared loop via `asyncio.run_coroutine_threadsafe()`.
- [ ] Properly shut down the loop on application exit.

#### 2.5.3 PERF-02: Replace Sleep-Polling Scheduler
**Ref**: PERF-02 | **Complexity**: Moderate | **Quick Win**: No
**File**: [backend/scan_engine.py](../../backend/scan_engine.py)

- [ ] Replace `time.sleep(5)` polling with `threading.Event.wait(timeout)` or migrate to `APScheduler`.
- [ ] This gives near-instant response to schedule changes and no CPU wakeups when idle.

---

### 2.6 Dependencies

#### 2.6.1 DEP-02: Lock Transitive Dependencies
**Ref**: DEP-02 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [backend/requirements.txt](../../backend/requirements.txt)

- [ ] Install `pip-tools`: `pip install pip-tools`.
- [ ] Rename current `requirements.txt` to `requirements.in`.
- [ ] Run `pip-compile requirements.in` to generate a fully locked `requirements.txt`.
- [ ] Update `backend/Dockerfile` to use the locked file.

#### 2.6.2 DEP-03: Add Vulnerability Scanning
**Ref**: DEP-03 | **Complexity**: Simple | **Quick Win**: Yes

- [ ] Add `pip-audit` to dev dependencies or CI pipeline.
- [ ] Document the command: `pip-audit -r requirements.txt`.

---

### 2.7 Frontend (Medium)

#### 2.7.1 FE-02: Add Data Fetching Error States
**Ref**: FE-02 | **Complexity**: Moderate | **Quick Win**: No
**Files**: Various page components

- [ ] Add error display states to pages that fetch data (DashboardPage, MapPage, SettingsPage, LogsPage).
- [ ] Show user-friendly error messages when API calls fail instead of silent failures.

#### 2.7.2 API-01: Standardize Response Formats
**Ref**: API-01 | **Complexity**: Complex | **Quick Win**: No
**Files**: All backend routers, frontend API layer

- [ ] Define a standard response envelope in `schemas.py`.
- [ ] This is a large refactor -- consider deferring and implementing gradually per-router.

---

## Phase 3 - Low Priority & Quality Improvements

### 3.1 Quick Wins

#### 3.1.1 BUG-04: Fix LogsPage useEffect Missing Dependency
**Ref**: BUG-04 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [frontend/src/pages/LogsPage.jsx](../../frontend/src/pages/LogsPage.jsx)

- [ ] Wrap `loadLogs` in `useCallback` or move the function body inside the `useEffect`.

#### 3.1.2 FE-03: Wrap localStorage in try/catch
**Ref**: FE-03 | **Complexity**: Simple | **Quick Win**: Yes
**Files**: [frontend/src/hooks/useRackOrders.js](../../frontend/src/hooks/useRackOrders.js), [frontend/src/hooks/useTopologyData.js](../../frontend/src/hooks/useTopologyData.js), [frontend/src/components/map/TopologyMap.jsx](../../frontend/src/components/map/TopologyMap.jsx)

- [ ] Wrap all `localStorage.getItem()` / `setItem()` / `sessionStorage` calls in try/catch:
  ```javascript
  function safeGetItem(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  ```

#### 3.1.3 SEC-06: Exempt Health Endpoint from Auth
**Ref**: SEC-06 | **Complexity**: Simple | **Quick Win**: Yes
**Files**: [backend/routers/health.py](../../backend/routers/health.py), [backend/main.py](../../backend/main.py)

- [ ] Include the health router before adding the global auth dependency, or create it without the auth dependency.

---

### 3.2 Code Quality Improvements

#### 3.2.1 CQ-05: Add Global Exception Handler
**Ref**: CQ-05 | **Complexity**: Simple | **Quick Win**: No
**File**: [backend/main.py](../../backend/main.py)

- [ ] Add a generic exception handler middleware:
  ```python
  @app.exception_handler(Exception)
  async def global_exception_handler(request, exc):
      import logging
      logging.getLogger("uvicorn.error").exception("Unhandled error")
      return JSONResponse(status_code=500, content={"detail": "Internal server error"})
  ```

#### 3.2.2 CQ-06: Use Enums for SNMP Constants
**Ref**: CQ-06 | **Complexity**: Moderate | **Quick Win**: No
**Files**: [backend/snmp_scanner.py](../../backend/snmp_scanner.py), [backend/scan_engine.py](../../backend/scan_engine.py)

- [ ] Define enums for SNMP versions, security levels, and vendor types.
- [ ] Replace magic string comparisons throughout the scanner code.

---

### 3.3 Performance (Low)

#### 3.3.1 PERF-05: Reuse SnmpEngine Per Scan Session
**Ref**: PERF-05 | **Complexity**: Moderate | **Quick Win**: No
**File**: [backend/snmp_scanner.py](../../backend/snmp_scanner.py)

- [ ] Create a single `SnmpEngine` per scan session and pass it to all SNMP operations.
- [ ] Ensure proper cleanup when the scan ends.

#### 3.3.2 PERF-04: Logs Search Optimization
**Ref**: PERF-04 | **Complexity**: Simple | **Quick Win**: No
**File**: [backend/routers/logs.py](../../backend/routers/logs.py)

- [ ] Acceptable for current buffer size (5000 entries). Defer unless scaling is planned.

---

### 3.4 Database Improvements

#### 3.4.1 DB-02: Configure Connection Pooling
**Ref**: DB-02 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [backend/database.py](../../backend/database.py)

- [ ] Already configured (verified in current code: `pool_size=10, max_overflow=20, pool_pre_ping=True, pool_recycle=300`). **No action needed.**

#### 3.4.2 DB-03: Add Database-Level Cascades
**Ref**: DB-03 | **Complexity**: Moderate | **Quick Win**: No
**Files**: Alembic migrations

- [ ] Create an Alembic migration to add `ON DELETE CASCADE` to foreign keys on `ports.device_id`, `devices.rack_id`, etc.

#### 3.4.3 DB-04: Use JSONB for Snapshot Columns
**Ref**: DB-04 | **Complexity**: Moderate | **Quick Win**: No
**Files**: [backend/database.py](../../backend/database.py), Alembic migrations

- [ ] Change `Text` columns storing JSON (`devices_snapshot_json`, `endpoint_details_json`) to PostgreSQL `JSONB`.
- [ ] Create an Alembic migration for the column type change.

---

### 3.5 API Design (Low)

#### 3.5.1 API-02: Add API Versioning
**Ref**: API-02 | **Complexity**: Moderate | **Quick Win**: No

- [ ] Defer. Current single-deployment model does not require API versioning.

#### 3.5.2 API-03: Deprecate Sync Scan Endpoint
**Ref**: API-03 | **Complexity**: Simple | **Quick Win**: Yes
**File**: [backend/routers/scan.py](../../backend/routers/scan.py)

- [ ] Add a deprecation warning to the sync `POST /api/scan` endpoint response or docstring.

#### 3.5.3 API-04: Add Pagination
**Ref**: API-04 | **Complexity**: Moderate | **Quick Win**: No

- [ ] Defer. Current dataset sizes (tens to hundreds of devices) do not warrant pagination.

---

### 3.6 Frontend (Low)

#### 3.6.1 FE-04: Tooltip Viewport Bounds Checking
**Ref**: FE-04 | **Complexity**: Simple | **Quick Win**: No
**File**: [frontend/src/components/Port.jsx](../../frontend/src/components/Port.jsx)

- [ ] Add viewport boundary detection to flip tooltip direction near screen edges.

#### 3.6.2 FE-05: Accessibility Improvements
**Ref**: FE-05 | **Complexity**: Complex | **Quick Win**: No

- [ ] Low priority for internal network tool. Defer unless required by policy.

#### 3.6.3 PERF-06: Frontend Inline Styles
**Ref**: PERF-06 | **Complexity**: Complex | **Quick Win**: No

- [ ] Defer. Functional and low user impact. Consider during a future UI overhaul.

---

## Implementation Priority Summary

### Immediate Quick Wins (do first)
| Item | Ref | Complexity | Est. Lines Changed |
|------|-----|------------|-------------------|
| Fix port status comparison | BUG-01 | Simple | 1 |
| Add security headers to nginx | SEC-02 | Simple | 5 |
| Redact passwords in exports | CRIT-03 | Simple | ~10 |
| Require SECRET_TOKEN | CRIT-02 | Simple | ~5 |
| Externalize DB password | CRIT-05 | Simple | ~10 |
| Replace imghdr | BUG-05 | Simple | ~5 |
| Commit package-lock.json | FE-06 | Simple | 1 config |
| Add 25G/40G speed labels | BUG-02 | Simple | 2 |
| Fix double API call | BUG-03 | Simple | ~10 |
| Replace datetime.utcnow | CQ-02 | Simple | ~15 |
| Alembic fail-fast | DB-01 | Simple | ~3 |

### Moderate Effort (do next)
| Item | Ref | Complexity |
|------|-----|------------|
| SVG sanitization | CRIT-04 | Moderate |
| Rate limiting | SEC-01 | Moderate |
| FastAPI lifespan migration | CQ-01 | Simple |
| File locking | CQ-04 | Simple |
| Docker resource limits | DK-01 | Simple |
| ETag optimization | PERF-03 | Moderate |

### Larger Refactors (plan separately)
| Item | Ref | Complexity |
|------|-----|------------|
| Encrypt passwords at rest | CRIT-01 | Complex |
| Standardize response formats | API-01 | Complex |
| Event loop reuse | PERF-01 | Moderate |
| Replace polling scheduler | PERF-02 | Moderate |
| SNMP enums | CQ-06 | Moderate |
