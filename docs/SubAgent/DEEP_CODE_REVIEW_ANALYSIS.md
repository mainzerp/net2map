# Deep Code Review Analysis: switch-map

**Date**: 2025-01-XX
**Scope**: Full project review -- backend, frontend, database, deployment, dependencies
**Project**: Network switch topology mapper with SNMP discovery, React dashboard

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Critical Issues](#critical-issues)
3. [Security](#security)
4. [Bugs](#bugs)
5. [Performance](#performance)
6. [Code Quality](#code-quality)
7. [API Design](#api-design)
8. [Frontend](#frontend)
9. [Database & Migrations](#database--migrations)
10. [Docker & Deployment](#docker--deployment)
11. [Dependencies](#dependencies)
12. [Recommendations Summary](#recommendations-summary)

---

## Executive Summary

The switch-map project is a network topology mapper combining a FastAPI/SQLAlchemy backend with a React SPA frontend, deployed via Docker Compose. It discovers network switches via SNMP (v2c/v3) and visualizes port states, topology links, and rack assignments.

The codebase is functional and well-structured with clear separation into routers, but contains several **critical security issues** (plaintext password storage, auth disabled by default, password leaks in exports), a confirmed **data bug** in port status counting, and multiple deprecation warnings that will break on Python 3.13+.

**Issue Count by Severity:**
| Severity | Count |
|----------|-------|
| CRITICAL | 5 |
| HIGH | 8 |
| MEDIUM | 12 |
| LOW | 10 |

---

## Critical Issues

### CRIT-01: SNMP Passwords Stored in Plaintext
- **Files**: `backend/database.py` (SnmpProfile, Credential models)
- **Description**: SNMPv3 authentication and privacy passwords (`v3_auth_password`, `v3_priv_password`) are stored as plain `String` columns in the database with no encryption.
- **Impact**: Any database access (SQL injection, backup leak, unauthorized DB access) exposes all SNMP credentials. SNMPv3 credentials can be used to reconfigure network equipment.
- **Recommendation**: Encrypt sensitive fields at rest using Fernet symmetric encryption or a dedicated secrets manager. Decrypt only at scan time.

### CRIT-02: Authentication Disabled by Default
- **File**: `backend/shared/auth.py`
- **Description**: `SECRET_TOKEN = os.getenv("SECRET_TOKEN", "")` -- when empty (the default), `_require_auth` returns immediately without checking any token. The `docker-compose.yml` sets `SECRET_TOKEN: ""`.
- **Impact**: The entire API is unauthenticated by default. Anyone with network access can trigger scans, export credentials, modify configuration, or delete data.
- **Recommendation**: Require a non-empty SECRET_TOKEN at startup; fail fast if not configured. Consider a more robust auth mechanism (API keys, OAuth, session tokens).

### CRIT-03: Bulk/Config Export Leaks Plaintext Passwords
- **Files**: `backend/routers/bulk.py`, `backend/routers/config.py`
- **Description**: Bulk export endpoints (`GET /api/bulk/credentials/export`, `GET /api/config/export`) serialize credentials including `v3_auth_password` and `v3_priv_password` in plaintext. While `SnmpProfileOut` and `CredentialOut` schemas mask passwords, the bulk export routes bypass these schemas and use internal model data directly.
- **Impact**: Any authenticated (or unauthenticated per CRIT-02) user can download all network credentials.
- **Recommendation**: Always route credential output through masking schemas, or implement explicit password redaction in export logic.

### CRIT-04: SVG Upload Allows XSS/XXE
- **File**: `backend/routers/map_bg.py`
- **Description**: The file upload endpoint accepts SVG files but explicitly bypasses content validation: SVGs pass through without `imghdr` checking. SVG files can contain inline JavaScript (`<script>` tags, `onload` handlers) and XML External Entity (XXE) declarations.
- **Impact**: Stored XSS if an SVG with JavaScript is uploaded and later rendered via `<img>` tag (mitigated) or opened directly. XXE could allow server-side file reads.
- **Recommendation**: Sanitize SVG uploads by stripping `<script>`, event handlers, and `<!ENTITY>` declarations. Consider using a library like `defusedxml` for XML parsing. Alternatively, convert SVGs to rasterized formats.

### CRIT-05: Hardcoded Database Password in docker-compose.yml
- **File**: `docker-compose.yml`
- **Description**: `POSTGRES_PASSWORD: netmap_pw` is hardcoded. `DATABASE_URL` includes the password in the connection string.
- **Impact**: Credential leak via version control. Default deployment is insecure.
- **Recommendation**: Use Docker secrets or `.env` files (excluded from version control) for database credentials. Document the requirement to change defaults.

---

## Security

### SEC-01: No Rate Limiting on API Endpoints (HIGH)
- **Files**: `backend/main.py`, `backend/routers/scan.py`
- **Description**: No rate limiting on any endpoint, including scan triggers (`POST /api/scan/jobs`), authentication, and bulk operations.
- **Impact**: DoS via rapid scan triggers (each scan spawns threads and makes network calls). Brute-force token guessing.
- **Recommendation**: Add `slowapi` or similar rate limiting middleware, especially on scan and auth endpoints.

### SEC-02: Missing Security Headers in Nginx (HIGH)
- **File**: `frontend/nginx.conf`
- **Description**: Nginx configuration lacks security headers: `X-Frame-Options`, `X-Content-Type-Options`, `Content-Security-Policy`, `Strict-Transport-Security`, `X-XSS-Protection`, `Referrer-Policy`.
- **Impact**: Clickjacking, MIME type sniffing attacks, missing HSTS.
- **Recommendation**: Add standard security headers:
  ```
  add_header X-Frame-Options "SAMEORIGIN";
  add_header X-Content-Type-Options "nosniff";
  add_header Referrer-Policy "strict-origin-when-cross-origin";
  ```

### SEC-03: CORS Origin from Environment Without Validation (MEDIUM)
- **File**: `backend/main.py`
- **Description**: `CORS_ORIGIN = os.getenv("CORS_ORIGIN", "http://localhost:5173")`. The value is used directly in `allow_origins` without any validation.
- **Impact**: Misconfigured CORS could allow cross-origin attacks if set to `*` or a malicious origin.
- **Recommendation**: Validate CORS_ORIGIN format. Consider an allowlist approach.

### SEC-04: subprocess.run for Ping Without Full Path (MEDIUM)
- **File**: `backend/scan_engine.py`
- **Description**: Uses `subprocess.run(["ping", ...])` without specifying the full path to the ping binary or restricting PATH.
- **Impact**: In a compromised environment, a malicious `ping` binary could be placed in PATH. (Mitigated by Docker container context.)
- **Recommendation**: Use full path `/bin/ping` in the subprocess call.

### SEC-05: Missing Auth Headers on Frontend Direct Fetch (MEDIUM)
- **File**: `frontend/src/hooks/useMapBackground.js`
- **Description**: Uses `fetch(url)` directly without including the `Authorization` header that `api.get()` would include.
- **Impact**: Map background requests fail silently when auth is enabled. Inconsistent auth behavior.
- **Recommendation**: Use the `api` helper for all API calls, or include auth headers in direct fetch calls.

### SEC-06: Health Endpoint Behind Auth (LOW)
- **File**: `backend/routers/health.py`
- **Description**: The health endpoint is registered with `include_in_schema=False` but is still subject to global auth dependency from `main.py`.
- **Impact**: Health checks from Docker or load balancers fail when auth is enabled unless they include the secret token.
- **Recommendation**: Exclude health endpoint from auth by creating a separate router without auth dependencies, or use a path-based exclusion.

---

## Bugs

### BUG-01: Port Status Count Compares Integer to String (HIGH)
- **File**: `backend/routers/settings.py`, line ~40
- **Code**: `port_up = db.query(Port).filter(Port.oper_status == "up").count()`
- **Description**: `Port.oper_status` is an `Integer` column (1=up, 2=down per SNMP IF-MIB ifOperStatus). Comparing to `"up"` (string) will always return 0 in PostgreSQL (type mismatch, silent failure) or 0 in SQLite.
- **Fix**: Change to `Port.oper_status == 1`
- **Impact**: Dashboard stats card always shows 0 active ports.

### BUG-02: speedLabel Missing 25G and 40G Tiers (MEDIUM)
- **File**: `frontend/src/api.js`
- **Description**: The `speedLabel` function maps SNMP speed values to labels but is missing entries for 25,000 (25G) and 40,000 (40G). The code comment says "keep in sync with backend" but the backend's `snmp_scanner.py` includes these values.
- **Impact**: 25G and 40G links show raw Mbps values instead of friendly labels.
- **Fix**: Add entries for 25000 and 40000 Mbps.

### BUG-03: Double API Call on Topology Data Mount (MEDIUM)
- **File**: `frontend/src/hooks/useTopologyData.js`
- **Description**: The hook calls `loadTopology()` inside the `useEffect` and also has initial state that triggers a load. This causes two identical API calls on mount.
- **Impact**: Unnecessary network request, doubled load on backend.
- **Fix**: Ensure single initial load.

### BUG-04: LogsPage useEffect Missing Dependency (LOW)
- **File**: `frontend/src/pages/LogsPage.jsx`
- **Description**: `loadLogs` is used inside `useEffect` but is not included in the dependency array. The function is recreated on each render, so the effect captures a stale closure.
- **Impact**: Functionally works because the function body doesn't depend on changing state directly, but violates React best practices and could cause subtle bugs if refactored.
- **Fix**: Wrap `loadLogs` in `useCallback` or move the function inside the effect.

### BUG-05: imghdr Module Removed in Python 3.13 (HIGH)
- **File**: `backend/routers/map_bg.py`
- **Description**: Uses `import imghdr` which is deprecated since Python 3.11 and **removed in Python 3.13**.
- **Impact**: Application will crash on Python 3.13+ when uploading images. Current Dockerfile uses Python 3.12-slim which still works, but upgrading Python will break this.
- **Fix**: Replace with `python-magic`, `Pillow`, or `filetype` library for MIME detection.

### BUG-06: Missing GlobalConfig Schemas (LOW)
- **File**: `backend/routers/config.py` references `GlobalConfigExportOut` and `GlobalConfigImportRequest` from `schemas.py`
- **Description**: These schemas may not be fully defined or may be defined differently than expected.
- **Impact**: Potential runtime errors if schema validation doesn't match the data structure.

---

## Performance

### PERF-01: New asyncio Event Loop Per Scan Thread (MEDIUM)
- **File**: `backend/scan_engine.py`
- **Description**: Each scan creates a new thread with `asyncio.new_event_loop()`. This is fragile and has overhead from event loop creation/teardown.
- **Impact**: Performance overhead per scan. Risk of event loop leaking if not properly closed.
- **Recommendation**: Use a single persistent event loop in a dedicated thread, or use `anyio`/`asyncio.Runner` (Python 3.11+).

### PERF-02: Background Scheduler Uses time.sleep Polling (MEDIUM)
- **File**: `backend/scan_engine.py`
- **Description**: `_background_scheduler()` runs in a daemon thread with `time.sleep(5)` polling loop, checking timestamps to decide when to run tasks.
- **Impact**: Up to 5-second jitter on scheduled tasks. Continuous CPU wake-ups even when idle.
- **Recommendation**: Use `APScheduler` or `asyncio` based scheduling for more precise and efficient scheduling.

### PERF-03: ETag Computation Serializes All Devices on Every Request (MEDIUM)
- **File**: `backend/routers/topology.py`
- **Description**: `list_all_devices()` serializes the entire topology to JSON, then MD5-hashes it for ETag on every request. This is O(n) in devices/ports/links on every call.
- **Impact**: Increasing cost as the network grows. The entire payload is built even when ETag matches.
- **Recommendation**: Use a monotonic version counter or timestamp-based ETag. Compute the response only when ETag doesn't match (304).

### PERF-04: Logs Endpoint Full-Scans Buffer for Text Search (LOW)
- **File**: `backend/routers/logs.py`
- **Description**: Text search on logs works by JSON-serializing every log entry and checking substring containment: `json.dumps(row).lower()`.
- **Impact**: O(n) per character per log entry. With 5000-entry buffer, this is fine, but scales poorly.
- **Recommendation**: Acceptable for current buffer size. If scaling, consider structured log indexing.

### PERF-05: New SnmpEngine Per SNMP Call (LOW)
- **File**: `backend/snmp_scanner.py`
- **Description**: Creates a new `SnmpEngine()` for each SNMP operation (getCmd, bulkWalkCmd, etc.).
- **Impact**: Engine creation overhead on every SNMP call. Can lead to resource leaks if engines aren't properly disposed.
- **Recommendation**: Reuse a single engine instance per scan session or worker.

### PERF-06: Frontend Inline Styles Instead of CSS (LOW)
- **Files**: All React components
- **Description**: Every component uses inline `style={{...}}` objects. These create new object references on every render.
- **Impact**: Minor: React can't optimize style diffing. Major: code bloat and poor maintainability.
- **Recommendation**: Extract common styles to CSS modules, Tailwind, or styled-components. Low priority for functionality.

---

## Code Quality

### CQ-01: Deprecated @app.on_event("startup") (MEDIUM)
- **File**: `backend/main.py`
- **Description**: Uses `@app.on_event("startup")` which is deprecated in recent FastAPI versions.
- **Fix**: Migrate to `lifespan` context manager pattern:
  ```python
  @asynccontextmanager
  async def lifespan(app):
      # startup
      yield
      # shutdown
  app = FastAPI(lifespan=lifespan)
  ```

### CQ-02: Deprecated datetime.utcnow() (MEDIUM)
- **File**: `backend/database.py`
- **Description**: Uses `datetime.utcnow` as `default`/`onupdate` for timestamp columns. Deprecated since Python 3.12.
- **Fix**: Use `datetime.now(datetime.UTC)` or `func.now()` (server-side).

### CQ-03: Single Workers Constraint Not Enforced (MEDIUM)
- **File**: `backend/shared/state.py`
- **Description**: Comment says "app MUST run with --workers 1" due to in-process state (LOG_BUFFER, SCAN_JOBS). This constraint is only documented in a comment, not enforced.
- **Impact**: Running with multiple workers causes duplicate scans, lost logs, and race conditions.
- **Recommendation**: Enforce at startup (check worker count) or move shared state to Redis/database.

### CQ-04: No File Locking on Settings I/O (MEDIUM)
- **File**: `backend/shared/file_settings.py`
- **Description**: File-based settings (map background, scan settings, DNS settings) use `json.load()`/`json.dump()` without file locking.
- **Impact**: Concurrent writes can corrupt settings files. Unlikely in single-worker mode but possible with concurrent API calls.
- **Recommendation**: Use `fcntl.flock()` (Unix) or `portalocker` for file locking, or move all settings to the database.

### CQ-05: Global Exception Handling Pattern (LOW)
- **Files**: Multiple routers
- **Description**: Many router endpoints lack explicit error handling, relying on FastAPI's default 500 response.
- **Impact**: Raw stack traces in responses. Inconsistent error formats.
- **Recommendation**: Add a global exception handler middleware for consistent error responses.

### CQ-06: Magic Strings for SNMP Constants (LOW)
- **Files**: `backend/snmp_scanner.py`, `backend/scan_engine.py`
- **Description**: SNMP versions, security levels, OIDs are scattered as string literals: `"v2c"`, `"v3"`, `"authPriv"`, `"noAuthNoPriv"`.
- **Recommendation**: Use Python enums for SNMP versions, security levels, and vendor types.

### CQ-07: TODO/FIXME Comments (LOW)
- **File**: `todo.md`
- **Description**: Project has a `todo.md` tracking planned features. Good practice, but some items relate to known architectural debt (multi-worker, Redis state).
- **Recommendation**: Convert critical items to tracked issues.

---

## API Design

### API-01: Inconsistent Response Formats (MEDIUM)
- **Files**: Various routers
- **Description**: Some endpoints return arrays, some return objects with `nodes`/`links` keys, some return `{"detail": ...}` on errors. No consistent envelope format.
- **Impact**: Frontend must handle different response shapes per endpoint.
- **Recommendation**: Standardize on a consistent response envelope: `{data, error, meta}`.

### API-02: No API Versioning (LOW)
- **Files**: All routers use `/api/` prefix
- **Description**: No version prefix (e.g., `/api/v1/`).
- **Impact**: Breaking changes require coordinating frontend/backend deployments.
- **Recommendation**: Add version prefix for future-proofing.

### API-03: Scan Job Endpoint Design (LOW)
- **File**: `backend/routers/scan.py`
- **Description**: The synchronous scan endpoint `POST /api/scan` runs the full scan in the request handler thread and returns when complete. For large networks, this can easily exceed timeout.
- **Impact**: HTTP timeouts on large scans.
- **Note**: The async job endpoint (`POST /api/scan/jobs`) properly handles this. Consider deprecating the sync endpoint.

### API-04: Missing Pagination on List Endpoints (LOW)
- **Files**: `backend/routers/credentials.py`, `backend/routers/topology.py`
- **Description**: List endpoints return all records without pagination.
- **Impact**: Performance degrades as dataset grows. Acceptable for typical network sizes (tens to hundreds of devices).

---

## Frontend

### FE-01: No CSS Framework or Style System (MEDIUM)
- **Files**: All components
- **Description**: 100% inline styles with no CSS modules, Tailwind, or styled-components. Style objects are recreated on every render.
- **Impact**: Code bloat, poor maintainability, no responsive design, no dark/light theme system.
- **Recommendation**: Migrate to Tailwind CSS or CSS modules. Low priority if current styling works.

### FE-02: No Loading/Error Boundaries for Data Fetching (MEDIUM)
- **File**: `frontend/src/components/ErrorBoundary.jsx`
- **Description**: ErrorBoundary exists but only catches render errors. No Suspense boundaries or data loading error states at route level.
- **Impact**: Unhandled promise rejections in data fetching are silently swallowed in some components.

### FE-03: localStorage/sessionStorage Used Without Error Handling (LOW)
- **Files**: `frontend/src/hooks/useRackOrders.js`, `frontend/src/hooks/useTopologyData.js`, `frontend/src/components/map/TopologyMap.jsx`
- **Description**: Direct `localStorage.getItem()`/`setItem()` calls without try/catch.
- **Impact**: Crashes in private browsing mode or when storage is full in some browsers (edge case).
- **Fix**: Wrap in try/catch.

### FE-04: Fixed Position Tooltip May Go Off-Screen (LOW)
- **File**: `frontend/src/components/Port.jsx`
- **Description**: Tooltip uses `position: fixed` with absolute pixel coordinates calculated from mouse position. No bounds checking for viewport edges.
- **Impact**: Tooltips for ports near screen edges are clipped or invisible.
- **Recommendation**: Add viewport boundary detection and flip tooltip direction when near edges.

### FE-05: No Accessibility (a11y) Considerations (LOW)
- **Files**: All components
- **Description**: No ARIA labels, no keyboard navigation support, no focus management, no screen reader support. Interactive elements use `<div>` with `onClick` instead of semantic `<button>`.
- **Impact**: Application is not accessible to users with disabilities.
- **Recommendation**: Low priority for an internal network tool, but worth noting.

### FE-06: Non-Reproducible Frontend Builds (MEDIUM)
- **File**: `frontend/Dockerfile`
- **Description**: No `package-lock.json` in the repo. `npm install` without a lockfile installs latest compatible versions, which can vary between builds.
- **Impact**: Build-to-build inconsistency. "Works on my machine" issues.
- **Fix**: Commit `package-lock.json` and use `npm ci` in the Dockerfile.

---

## Database & Migrations

### DB-01: Alembic Fallback URL is SQLite (MEDIUM)
- **File**: `backend/alembic/env.py`
- **Description**: `fallback_url = config.get_main_option("sqlalchemy.url")` which defaults to the SQLite URL in `alembic.ini`. If `DATABASE_URL` env var is not set, migrations target a local SQLite file instead of PostgreSQL.
- **Impact**: Silent migration to wrong database if env var is missing.
- **Fix**: Fail fast if `DATABASE_URL` is not set instead of falling back to SQLite.

### DB-02: No Database Connection Pooling Configuration (LOW)
- **File**: `backend/database.py`
- **Description**: SQLAlchemy engine is created with `create_engine(DATABASE_URL)` using default pool settings.
- **Impact**: Default pool size (5) may be insufficient under load, or wasteful for single-worker mode.
- **Recommendation**: Configure `pool_size`, `max_overflow`, and `pool_recycle` explicitly.

### DB-03: cascade="all,delete-orphan" vs Database-Level Cascades (LOW)
- **Files**: `backend/database.py`
- **Description**: ORM-level cascades are used. Database-level foreign key cascades are not set in the Alembic migrations.
- **Impact**: Deletes only cascade properly when going through the ORM. Direct SQL deletes or database-level operations won't cascade.
- **Recommendation**: Add `ON DELETE CASCADE` in the migration foreign key definitions for consistency.

### DB-04: devices_snapshot_json Stored as Text (LOW)
- **File**: `backend/database.py` (ScanRun model)
- **Description**: JSON data stored in `Text` columns instead of PostgreSQL `JSONB` type.
- **Impact**: No indexing or querying capability on snapshot data. Larger storage footprint.
- **Recommendation**: Use `JSONB` column type for structured data storage.

---

## Docker & Deployment

### DK-01: No Resource Limits in docker-compose.yml (MEDIUM)
- **File**: `docker-compose.yml`
- **Description**: No memory or CPU limits on any service.
- **Impact**: A runaway scan engine could consume all host resources.
- **Recommendation**: Add `deploy.resources.limits` for memory and CPU.

### DK-02: Backend Runs as Root Before Privilege Drop (LOW)
- **File**: `backend/entrypoint.sh`
- **Description**: Container starts as root, runs Alembic migrations as root, then drops to `appuser` via `gosu`. The migration step runs with full privileges.
- **Impact**: If migrations are compromised, they run as root. Acceptable pattern but worth documenting.

### DK-03: No Health Check on Backend Service (MEDIUM)
- **File**: `docker-compose.yml`
- **Description**: Backend service has no `healthcheck` defined (only PostgreSQL has one). Docker/orchestrators can't determine if the backend is actually serving requests.
- **Fix**: Add healthcheck using the `/api/health` endpoint.

### DK-04: No TLS Configuration (MEDIUM)
- **File**: `frontend/nginx.conf`
- **Description**: Nginx serves HTTP only. No HTTPS/TLS configuration.
- **Impact**: All traffic (including auth tokens, SNMP credentials in API calls) is transmitted in plaintext.
- **Recommendation**: Add TLS termination at nginx or use a reverse proxy (Traefik, Caddy) that handles it.

---

## Dependencies

### DEP-01: psycopg2-binary in Production (LOW)
- **File**: `backend/requirements.txt`
- **Description**: Uses `psycopg2-binary` which includes a bundled copy of libpq. The psycopg2 docs recommend the source-compiled `psycopg2` package for production.
- **Impact**: Potential compatibility issues with the system libpq. Minor risk.
- **Recommendation**: Acceptable for Docker deployments where the environment is controlled.

### DEP-02: No Python Dependency Lockfile (MEDIUM)
- **File**: `backend/requirements.txt`
- **Description**: While versions are pinned with `==`, transitive dependencies are not locked.
- **Impact**: Different `pip install` runs may pull different transitive dependency versions.
- **Recommendation**: Use `pip-tools` with `requirements.in`/`requirements.txt` or `poetry.lock`.

### DEP-03: Pinned Versions May Have Known Vulnerabilities (MEDIUM)
- **File**: `backend/requirements.txt`
- **Description**: Pinned versions (e.g., FastAPI 0.115.5, SQLAlchemy 2.0.36) should be periodically checked against vulnerability databases.
- **Recommendation**: Add `pip-audit` or `safety` to CI pipeline.

---

## Recommendations Summary

### Must Fix (Critical/High)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| CRIT-01 | Encrypt SNMP passwords at rest | database.py | Medium |
| CRIT-02 | Require non-empty SECRET_TOKEN | shared/auth.py, docker-compose.yml | Low |
| CRIT-03 | Redact passwords in bulk/config export | routers/bulk.py, routers/config.py | Low |
| CRIT-04 | Sanitize SVG uploads | routers/map_bg.py | Medium |
| CRIT-05 | Remove hardcoded DB password | docker-compose.yml | Low |
| BUG-01 | Fix port_up status comparison (== 1) | routers/settings.py | Trivial |
| BUG-05 | Replace deprecated imghdr | routers/map_bg.py | Low |
| SEC-01 | Add rate limiting | main.py | Medium |
| SEC-02 | Add security headers to nginx | nginx.conf | Low |
| FE-06 | Commit package-lock.json, use npm ci | frontend/Dockerfile | Trivial |
| DK-03 | Add backend healthcheck | docker-compose.yml | Trivial |

### Should Fix (Medium)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| BUG-02 | Add 25G/40G to speedLabel | api.js | Trivial |
| BUG-03 | Fix double API call on mount | useTopologyData.js | Trivial |
| CQ-01 | Migrate to lifespan pattern | main.py | Low |
| CQ-02 | Replace datetime.utcnow | database.py | Low |
| CQ-03 | Enforce single-worker constraint | main.py or state.py | Low |
| CQ-04 | Add file locking for settings | file_settings.py | Low |
| PERF-01 | Reuse event loop | scan_engine.py | Medium |
| PERF-02 | Replace sleep-polling scheduler | scan_engine.py | Medium |
| PERF-03 | Optimize ETag computation | routers/topology.py | Medium |
| DB-01 | Fail fast on missing DATABASE_URL | alembic/env.py | Trivial |
| DK-01 | Add Docker resource limits | docker-compose.yml | Low |
| DK-04 | Document/add TLS configuration | nginx.conf | Medium |
| SEC-03 | Validate CORS_ORIGIN | main.py | Low |
| API-01 | Standardize response envelope | All routers | High |
| DEP-02 | Lock transitive dependencies | requirements.txt | Low |

### Nice to Have (Low)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| BUG-04 | Fix LogsPage useEffect deps | LogsPage.jsx | Trivial |
| SEC-06 | Exempt health endpoint from auth | health.py, main.py | Low |
| CQ-05 | Global exception handler | main.py | Low |
| CQ-06 | Use enums for SNMP constants | snmp_scanner.py | Medium |
| FE-03 | Wrap localStorage in try/catch | hooks/*.js | Trivial |
| FE-04 | Tooltip viewport bounds checking | Port.jsx | Low |
| FE-05 | Accessibility improvements | All components | High |
| PERF-04 | Logs search optimization | routers/logs.py | Low |
| PERF-05 | Reuse SnmpEngine | snmp_scanner.py | Medium |
| DB-02 | Configure connection pooling | database.py | Low |
| DB-03 | Add DB-level cascades | migrations | Medium |
| DB-04 | Use JSONB for snapshot columns | database.py, migrations | Medium |
| API-02 | Add API versioning | All routers | Medium |
| API-03 | Deprecate sync scan endpoint | routers/scan.py | Low |
| API-04 | Add pagination | routers/*.py | Medium |
| DEP-01 | Consider psycopg2 source build | requirements.txt | Low |

---

## Architecture Notes

### Strengths
- Clean router separation with dedicated files per domain
- ETag caching on topology endpoint reduces bandwidth
- Background async scan jobs with polling pattern
- SNMP v2c/v3 support with vendor-specific strategies
- Password masking on API output schemas (SnmpProfileOut, CredentialOut)
- Docker multi-stage builds for small images
- Alembic migrations for schema management
- Proper privilege dropping in Docker entrypoint

### Architectural Debt
1. **In-process state** (LOG_BUFFER, SCAN_JOBS) prevents horizontal scaling
2. **File-based settings** alongside database settings creates a dual-source-of-truth problem
3. **No test suite**: zero unit or integration tests found in the codebase
4. **No CI/CD pipeline**: no GitHub Actions, no linting, no automated testing
5. **Frontend has no state management library**: relies on prop drilling and local component state

---

*End of analysis.*
