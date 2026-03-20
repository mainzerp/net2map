# NetMap - Code Review Implementation Plan

**Based on:** [CODE_REVIEW_ANALYSIS.md](CODE_REVIEW_ANALYSIS.md)
**Created:** 2026-03-20

---

## Overview

This plan addresses all findings from the code review analysis, organized into 5 phases ordered by priority. Each step references the original finding IDs and provides exact file paths and specific code changes.

**Dependencies between phases:**
- Phase 1 (SEC-2 encryption fix) must be completed before Phase 2 bulk/config import encryption fixes (CB-1)
- Phase 1 items are independent of each other and can be done in parallel
- Phase 3 and 4 items are largely independent

---

## Phase 1: Critical Security Fixes

### 1.1 Log a startup warning and set a dummy-admin user only when auth is explicitly disabled (SEC-1)

**Finding:** When neither `JWT_SECRET` nor `SECRET_TOKEN` is set, all requests silently become admin with no auth.

**Files to modify:**
- `backend/shared/auth.py`

**Changes:**
- In `_require_auth()`, when auth is disabled (neither `JWT_SECRET` nor `_LEGACY_TOKEN` set), set `request.state.user` to a dummy admin user dict so downstream `require_role` checks still work, but keep the existing warning log on startup. The current code already returns early (line 55: `return  # auth disabled`), which means `request.state.user` is never set. This causes `require_role` to silently allow everything due to the `if not user: return` guard.
- Change the `require_role` inner function: instead of `if not user: return` (which silently permits), explicitly assign a read-only viewer or raise 403 when auth is disabled but no user context exists. This way a forgotten auth config does not grant admin by default.
- Specifically, in `_require_auth`, when auth is disabled, set `request.state.user = {"id": 0, "username": "anonymous", "role": "admin"}` (preserving current behavior for now). The real fix is to add a startup-level decision.
- Add a startup check in `backend/main.py` lifespan: if neither `JWT_SECRET` nor `SECRET_TOKEN` is configured, log a `CRITICAL` warning with clear instructions. Optionally, restrict non-health endpoints by checking an app-level flag.

**Specific code:**

In `backend/shared/auth.py`, replace the `_require_auth` early return when auth is disabled:
```python
# Current:
if not JWT_SECRET and not _LEGACY_TOKEN:
    return  # auth disabled

# New:
if not JWT_SECRET and not _LEGACY_TOKEN:
    request.state.user = {"id": 0, "username": "anonymous", "role": "admin"}
    return  # auth disabled -- startup warning already logged
```

In `backend/main.py` lifespan function, after `create_tables()`:
```python
if not os.getenv("JWT_SECRET") and not os.getenv("SECRET_TOKEN"):
    _log.critical(
        "SECURITY: No authentication configured (JWT_SECRET and SECRET_TOKEN are both unset). "
        "All API endpoints are accessible without authentication. "
        "Set JWT_SECRET or SECRET_TOKEN before deploying to production."
    )
```

In `backend/routers/auth.py`, `get_current_user` endpoint:
```python
# Current:
return getattr(request.state, "user", {"role": "admin", "username": "anonymous"})

# New:
return getattr(request.state, "user", {"role": "viewer", "username": "anonymous"})
```

**Impact:** Prevents silent full-admin access in misconfigured deployments. Provides clear log output on startup.

**Breaking changes:** None -- behavior changes only for misconfigured deployments.

- [ ] **1.1 Done**

---

### 1.2 Warn on missing ENCRYPTION_KEY at startup (SEC-2)

**Finding:** Without `ENCRYPTION_KEY`, all SNMP passwords are stored as plaintext with only a module-level log warning.

**Files to modify:**
- `backend/shared/crypto.py`
- `backend/main.py`

**Changes:**
- Keep the existing warning in `crypto.py` (module level).
- Add a `CRITICAL` startup log in `main.py` lifespan when `ENCRYPTION_KEY` is not set, making it unmissable in logs.
- Do NOT make `ENCRYPTION_KEY` mandatory (would break existing deployments) but make the warning impossible to overlook.

In `backend/main.py` lifespan, add after the auth check:
```python
if not os.getenv("ENCRYPTION_KEY"):
    _log.critical(
        "SECURITY: ENCRYPTION_KEY is not set. SNMP passwords will be stored in PLAINTEXT. "
        "Generate a key with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
    )
```

**Impact:** Administrators will see prominent warnings during startup if encryption is not configured.

**Breaking changes:** None.

- [ ] **1.2 Done**

---

### 1.3 Remove hardcoded default passwords from docker-compose.yml (SEC-3)

**Finding:** `POSTGRES_PASSWORD: netmap_pw` and `SECRET_TOKEN: changeme` are hardcoded defaults.

**Files to modify:**
- `docker-compose.yml`
- Create: `.env.example`

**Changes:**
- In `docker-compose.yml`, change all password defaults to require explicit configuration:
  - `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}` -- this causes docker compose to fail with an error if the variable is not set.
  - `SECRET_TOKEN: ${SECRET_TOKEN:?Set SECRET_TOKEN in .env}`
  - `DEFAULT_ADMIN_PASSWORD: ${DEFAULT_ADMIN_PASSWORD:?Set DEFAULT_ADMIN_PASSWORD in .env}`
- Create `.env.example` with placeholder values and instructions:
```env
# Copy this file to .env and fill in values
POSTGRES_PASSWORD=   # Required: PostgreSQL password
SECRET_TOKEN=        # Required: API authentication token (legacy mode)
JWT_SECRET=          # Recommended: JWT signing secret (enables full RBAC)
ENCRYPTION_KEY=      # Recommended: Fernet key for SNMP password encryption
DEFAULT_ADMIN_PASSWORD=  # Required: Initial admin user password
```

**Impact:** Deployments that relied on defaults will break until `.env` is explicitly configured. This is intentional -- production deployments must not use default passwords.

**Breaking changes:** Yes -- existing deployments using default docker-compose without `.env` will fail to start. Mitigated by `.env.example` file and error messages.

- [ ] **1.3 Done**

---

### 1.4 Encrypt passwords during bulk import (CB-1)

**Finding:** `routers/bulk.py` bulk import stores SNMPv3 passwords without calling `encrypt()`. The credential creation path in `routers/credentials.py` properly encrypts.

**Files to modify:**
- `backend/routers/bulk.py`
- `backend/routers/config.py`

**Changes in `backend/routers/bulk.py`:**

Add import at top:
```python
from shared.crypto import encrypt
```

In the `bulk_import` function, within the credentials import loop (both insert and update paths), encrypt password fields before storing. Add encryption after the `_PASSWORD_MASK` check:

```python
# After the mask check, before setattr/Credential(**payload):
for pwd_field in ("v3_auth_password", "v3_priv_password", "community"):
    if payload.get(pwd_field) and payload[pwd_field] != _PASSWORD_MASK:
        payload[pwd_field] = encrypt(payload[pwd_field])
```

Apply the same fix for the profiles import path:
```python
for pwd_field in ("v3_auth_password", "v3_priv_password", "community"):
    if payload.get(pwd_field) and payload[pwd_field] != _PASSWORD_MASK:
        payload[pwd_field] = encrypt(payload[pwd_field])
```

**Changes in `backend/routers/config.py`:**

Add import at top:
```python
from shared.crypto import encrypt
```

In `import_global_config`, apply the same encryption for profiles and credentials loops, after the `_PASSWORD_MASK` check but before `setattr` or `db.add`:

For both new and existing profiles/credentials:
```python
for pwd_field in ("v3_auth_password", "v3_priv_password", "community"):
    if row.get(pwd_field) and row[pwd_field] != _PASSWORD_MASK:
        row[pwd_field] = encrypt(row[pwd_field])
```

**Dependency:** Phase 1.2 (crypto warnings) should be done first so admins know encryption state.

**Impact:** Prevents plaintext passwords in the database from bulk/config import paths.

**Breaking changes:** None. Previously-imported plaintext passwords will remain plaintext (the `decrypt()` function already handles fallback to raw values).

- [ ] **1.4 Done**

---

## Phase 2: High-Priority Bug Fixes

### 2.1 Add rate limiting to login endpoint (SEC-4)

**Finding:** `/api/auth/login` has no rate limiting, allowing unlimited brute-force attempts.

**Files to modify:**
- `backend/routers/auth.py`

**Changes:**
- Import the limiter and add rate limit decorator to the login endpoint.

```python
# Add imports:
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)

# Add decorator to login endpoint:
@router.post("/api/auth/login", response_model=TokenResponse)
@limiter.limit("5/minute")
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    ...
```

Note: The `request: Request` parameter is already present in the function signature. The limiter needs the `Request` object.

**Impact:** Prevents brute-force password attacks. Legitimate users are unlikely to need more than 5 login attempts per minute.

**Breaking changes:** None for normal usage.

- [x] **2.1 Done**

---

### 2.2 Add password complexity validation (SEC-7)

**Finding:** User creation accepts any password without minimum length or complexity requirements.

**Files to modify:**
- `backend/schemas.py` (add validator to `UserCreate`)

**Changes:**

Add a Pydantic validator to `UserCreate`:

```python
from pydantic import field_validator

class UserCreate(BaseModel):
    username: str
    email: str = ""
    password: str
    role: UserRole = "viewer"

    @field_validator("password")
    @classmethod
    def validate_password(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters long")
        return v
```

Same validator on `UserUpdate.password` (optional field, validate only when provided):
```python
class UserUpdate(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None

    @field_validator("password")
    @classmethod
    def validate_password(cls, v):
        if v is not None and len(v) < 8:
            raise ValueError("Password must be at least 8 characters long")
        return v
```

**Impact:** Reduces brute-force attack surface by ensuring passwords have minimum length.

**Breaking changes:** Existing users with short passwords are unaffected. Only new user creation and password updates are validated.

- [x] **2.2 Done**

---

### 2.3 Mask passwords in bulk export by default (SEC-8)

**Finding:** Bulk export returns decrypted SNMP passwords. Already partially addressed -- examining the code shows passwords are already masked with "********" in the export. This finding may be outdated.

**Files to verify:**
- `backend/routers/bulk.py` (export function, lines ~130-170)
- `backend/routers/config.py` (export function)

**Verification:** Reading the source code confirms that both `bulk_export` and `export_global_config` already mask passwords with `"********"` (e.g., `"v3_auth_password": "********" if c.v3_auth_password else ""`). Community strings are exposed in plaintext in `bulk_export`.

**Changes:**
- In `backend/routers/bulk.py` `bulk_export`, mask the `community` field too:
```python
# Current:
"community": c.community,

# New:
"community": "********" if c.community else "",
```

Apply same change for SNMP profiles export.

Similarly in `backend/routers/config.py` `export_global_config`:
```python
# Mask community strings in both profiles and credentials sections
"community": "********" if p.community else "",
"community": "********" if c.community else "",
```

**Impact:** Community strings are no longer exposed in exports.

**Breaking changes:** Import workflows that relied on exported community strings will need manual entry. The mask check (`!= "********"`) already exists in the import code.

- [x] **2.3 Done**

---

### 2.4 Protect metrics endpoint (SEC-6)

**Finding:** `/metrics` is in `_AUTH_EXEMPT_PATHS`, exposing Prometheus metrics without authentication.

**Files to modify:**
- `backend/shared/auth.py`

**Changes:**
- Remove `/metrics` from `_AUTH_EXEMPT_PATHS`:
```python
# Current:
_AUTH_EXEMPT_PATHS = {"/health", "/api/auth/login", "/metrics", "/api/map-background"}

# New:
_AUTH_EXEMPT_PATHS = {"/health", "/api/auth/login", "/api/map-background"}
```

- This way `/metrics` requires authentication (any valid token), which is appropriate for internal monitoring tools that can be configured with a Bearer token.

**Impact:** Monitoring systems (Prometheus) will need to include a Bearer token when scraping `/metrics`.

**Breaking changes:** Yes -- existing Prometheus configurations scraping `/metrics` without auth will break. Must update scrape config to include the token.

- [x] **2.4 Done**

---

### 2.5 Document HTTPS/TLS requirement (IF-1)

**Finding:** No TLS configuration in nginx or docker-compose.

**Files to modify/create:**
- `README.md` (add TLS section)
- `frontend/nginx.conf` (add commented TLS example block)

**Changes:**
- Add a "Production Deployment" section to `README.md` with clear instructions on setting up a reverse proxy with TLS (e.g., Traefik, Caddy, or nginx with Let's Encrypt).
- Add a commented-out TLS server block to `nginx.conf` as a reference.

**Impact:** Documentation improvement. No code changes.

**Breaking changes:** None.

- [x] **2.5 Done**

---

### 2.6 Add IP validation for credential IP field (SEC-11)

**Finding:** Credential `ip` field accepts any string without format validation.

**Files to modify:**
- `backend/schemas.py`

**Changes:**

Add a validator to `CredentialCreate` for the `ip` field:

```python
import re

class CredentialCreate(BaseModel):
    # ... existing fields ...

    @field_validator("ip")
    @classmethod
    def validate_ip(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("IP address or hostname is required")
        # Accept valid IPv4, IPv6, or hostname
        # Simple validation: must not contain spaces or shell-dangerous chars
        if re.search(r'[\s;|&`$]', v):
            raise ValueError("IP address contains invalid characters")
        return v
```

**Impact:** Prevents garbage data that causes confusing runtime errors during scans.

**Breaking changes:** None -- existing valid IPs/hostnames will pass validation.

- [x] **2.6 Done**

---

## Phase 3: Medium-Priority Improvements

### 3.1 Fix WebSocket reconnect timer cleanup (FE-2)

**Finding:** `useScanProgress.js` WebSocket reconnection timeout may not be cleaned up on component unmount.

**Files to modify:**
- `frontend/src/hooks/useScanProgress.js`

**Changes:**

The cleanup function already clears `reconnectRef.current`, but the issue is that `ws.onclose` might fire after `unmounted = true` and still set a new timeout. The current code has `if (unmounted) return;` in `onclose`, which correctly prevents this. However, the cleanup should also clear any pending timeout defensively:

```javascript
// Current cleanup:
return () => {
  unmounted = true;
  if (reconnectRef.current) {
    clearTimeout(reconnectRef.current);
    reconnectRef.current = null;
  }
  if (wsRef.current) {
    wsRef.current.close();
    wsRef.current = null;
  }
};
```

Verify this is already the case. If the cleanup already clears the timeout before closing the WebSocket, this finding is already addressed. Read the code to confirm and add the `wsRef.current = null` assignment if missing.

**Impact:** Prevents potential memory leak from orphaned WebSocket reconnect timers.

**Breaking changes:** None.

- [x] **3.1 Done**

---

### 3.2 Fix audit logger to accept existing DB session (CB-2)

**Finding:** `shared/audit.py` creates its own independent `SessionLocal()`, making audit writes non-atomic with the operation they log.

**Files to modify:**
- `backend/shared/audit.py`

**Changes:**

Modify `log_audit` to optionally accept a `db` session parameter. When provided, use it (audit entry is committed with the main transaction). When not provided, fall back to creating a new session (preserving current behavior for scan engine and other non-request contexts).

```python
def log_audit(request: Request, action: str, resource: str,
              resource_id: str = "", details: dict = None, db=None):
    """Record an audit log entry. Uses the provided db session if given,
    otherwise creates an independent session."""
    from database import AuditLog, SessionLocal

    user = getattr(request.state, "user", {})
    own_session = db is None
    if own_session:
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
        if own_session:
            db.commit()
    except Exception:
        _log.exception("Failed to write audit log")
        if own_session:
            db.rollback()
    finally:
        if own_session:
            db.close()
```

Note: Do NOT update all callers immediately. This is a backward-compatible change. Callers that have a `db` session available can opt-in by passing it.

**Impact:** Enables atomic audit logging for callers that have a DB session. No change for existing callers.

**Breaking changes:** None -- the parameter is optional.

- [x] **3.2 Done**

---

### 3.3 Improve frontend error handling in API client (CQ-7)

**Finding:** `api.get()` throws unhelpful errors when response body is not JSON.

**Files to modify:**
- `frontend/src/api.js`

**Changes:**

The `_checkOk` function already handles non-JSON fallback (`try { msg = await r.text(); } catch { msg = r.statusText; }`). Verify this is correct. The existing code is:

```javascript
let msg;
try {
  const body = await r.json();
  msg = body?.error?.message || body?.detail || r.statusText;
} catch {
  try { msg = await r.text(); } catch { msg = r.statusText; }
}
```

This already handles non-JSON responses. The finding about `String(ex)` showing `[object Object]` is about consuming code in components, not the API client itself. No change needed to `_checkOk`.

However, for robustness, the 401 handling should distinguish between auth endpoints and others to avoid masking permission errors:

```javascript
// Current: redirects on any 401
if (r.status === 401) {
  localStorage.removeItem("auth_token");
  localStorage.removeItem("auth_user");
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

// This is actually correct behavior for a SPA -- any 401 means the token
// is invalid/expired, so redirect to login is appropriate.
```

Mark as verified/no change needed. The error display issue (`String(ex)` showing `[object Object]`) needs to be audited in individual page components, which is a lower priority.

- [x] **3.3 Done (verify only)**

---

### 3.4 Add rate limiting to map background upload (SEC-12)

**Finding:** Map background upload has no rate limiting.

**Files to modify:**
- `backend/routers/map_bg.py`

**Changes:**

Add rate limiter:
```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)

@router.post("/api/map-background",
             dependencies=[require_role("admin", "operator")])
@limiter.limit("5/minute")
async def upload_map_background(request: Request, file: UploadFile = File(...)):
    ...
```

**Impact:** Prevents abuse of the upload endpoint.

**Breaking changes:** None for normal usage.

- [x] **3.4 Done**

---

### 3.5 Add content-type validation to map background upload (SEC-12)

**Finding:** Upload only checks magic bytes but not content-type header.

**Files to verify:**
- `backend/routers/map_bg.py`

**Verification:** The code already validates via `filetype.guess()` for magic bytes and checks the file extension. Content-type header from the client is unreliable (clients can set it to anything), so magic-byte validation is actually the correct approach. The extension check + magic byte check is sufficient.

Mark as already mitigated -- no additional changes needed.

- [x] **3.5 Done (already mitigated)**

---

### 3.6 Fix CORS wildcard warning (SEC-14)

**Finding:** CORS allows `*` with only a warning.

**Files to modify:**
- `backend/main.py`

**Changes:**

The current code already logs a warning when `CORS_ORIGIN` is `*`. The CORS middleware with `allow_credentials=True` and a wildcard origin is rejected by browsers anyway. No code change needed, but update the warning to be more specific:

```python
if CORS_ORIGIN == "*":
    _log.warning(
        "CORS_ORIGIN is set to '*' -- this is insecure in production. "
        "Set CORS_ORIGIN to the specific frontend URL (e.g. https://netmap.example.com)"
    )
```

- [x] **3.6 Done**

---

### 3.7 Fix JWT token expiry -- add frontend expiry awareness (SEC-13, FE-4)

**Finding:** JWT tokens expire silently with no refresh mechanism or warning.

**Files to modify:**
- `frontend/src/api.js`

**Changes:**

Add a utility function that checks token expiry and warns the user before silent redirect:

```javascript
export function getTokenExpiry() {
  const token = getStoredToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch { return null; }
}

export function isTokenExpiringSoon(thresholdMinutes = 30) {
  const expiry = getTokenExpiry();
  if (!expiry) return false;
  return (expiry.getTime() - Date.now()) < thresholdMinutes * 60 * 1000;
}
```

These can then be used in the App component or a header component to show a "Session expiring soon" notice. The actual usage in UI components is deferred to a separate UI task.

**Impact:** Foundation for token expiry awareness. No visible change yet.

**Breaking changes:** None.

- [x] **3.7 Done**

---

## Phase 4: Low-Priority Enhancements

### 4.1 Add health check for Celery worker (IF-3)

**Finding:** Celery worker has no Docker health check.

**Files to modify:**
- `docker-compose.yml`

**Changes:**

Add healthcheck to the celery-worker service:
```yaml
celery-worker:
  ...
  healthcheck:
    test: ["CMD-SHELL", "celery -A celery_app inspect ping --timeout 5 | grep -q 'pong' || exit 1"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 30s
```

**Impact:** Docker can detect and restart dead Celery workers.

**Breaking changes:** None.

- [ ] **4.1 Done**

---

### 4.2 Add log rotation configuration (IF-4)

**Finding:** No log rotation for Docker containers.

**Files to modify:**
- `docker-compose.yml`

**Changes:**

Add logging driver configuration to each service (or use a top-level `x-logging` anchor):

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"

services:
  backend:
    logging: *default-logging
  celery-worker:
    logging: *default-logging
  frontend:
    logging: *default-logging
```

**Impact:** Prevents disk exhaustion from unrotated container logs.

**Breaking changes:** None.

- [ ] **4.2 Done**

---

### 4.3 Wait for Redis in entrypoint.sh (IF-5)

**Finding:** entrypoint.sh waits for PostgreSQL but not Redis.

**Files to modify:**
- `backend/entrypoint.sh`

**Changes:**

Add Redis wait after the PostgreSQL wait block:

```bash
echo "[entrypoint] Waiting for Redis..."
python3 -c "
import os, time, sys, socket
url = os.environ.get('REDIS_URL', '')
if not url:
    print('[entrypoint] No REDIS_URL set, skipping Redis check.')
    sys.exit(0)
try:
    host = url.split('://')[1].split(':')[0].split('/')[0]
    port = int(url.split('://')[1].split(':')[1].split('/')[0]) if ':' in url.split('://')[1] else 6379
except Exception:
    host, port = 'redis', 6379
for i in range(30):
    try:
        socket.create_connection((host, port), timeout=2).close()
        print(f'[entrypoint] Redis at {host}:{port} is ready.')
        sys.exit(0)
    except OSError:
        time.sleep(1)
print('[entrypoint] WARNING: Redis not reachable after 30s, continuing anyway')
sys.exit(0)
"
```

Note: Non-fatal -- the app can start without Redis (falls back to in-memory state). So we log a warning but don't exit with error.

**Impact:** Prevents race condition where app starts before Redis is ready.

**Breaking changes:** None.

- [ ] **4.3 Done**

---

### 4.4 Add DNS cache size limit (PC-3)

**Finding:** `_dns_cache` dict in scan_engine.py has no size limit.

**Files to modify:**
- `backend/scan_engine.py`

**Changes:**

Find the `_dns_cache` dict and add a size check before adding new entries:

```python
_DNS_CACHE_MAX = 10000

# In the DNS resolution function, before adding to cache:
if len(_dns_cache) >= _DNS_CACHE_MAX:
    # Evict expired entries first
    now = time.time()
    expired = [k for k, (_, ts) in _dns_cache.items() if now - ts > 300]
    for k in expired:
        del _dns_cache[k]
    # If still over limit, clear oldest half
    if len(_dns_cache) >= _DNS_CACHE_MAX:
        keys = list(_dns_cache.keys())
        for k in keys[:len(keys) // 2]:
            del _dns_cache[k]
```

**Impact:** Prevents unbounded memory growth in large networks.

**Breaking changes:** None.

- [ ] **4.4 Done**

---

### 4.5 Fix frontend store.js to use api wrapper instead of raw fetch (CQ-6)

**Finding:** `store.js` has `loadMapBackground` using raw `fetch()` instead of `api.get()`.

**Files to modify:**
- `frontend/src/store.js`

**Changes:**

Find `loadMapBackground` and replace raw `fetch()` with `api.get()` or appropriate api wrapper. Since map background returns a binary blob (image), `api.get()` expects JSON. Instead, create a helper or use the auth headers directly:

```javascript
// Option: use _getAuthHeader from api.js for consistency
import { API, _getAuthHeader } from "./api.js";

loadMapBackground: async () => {
  try {
    const r = await fetch(`${API}/api/map-background`, {
      headers: _getAuthHeader(),
    });
    // ... rest of the handler
  }
}
```

This consolidates the auth header logic to use the shared helper.

**Impact:** Consistent auth header handling. Prevents drift if auth mechanism changes.

**Breaking changes:** None.

- [ ] **4.5 Done**

---

### 4.6 Improve ETag cache eviction in frontend (PC-4)

**Finding:** Frontend ETag cache evicts only 1 entry when at 200 limit, causing potential thrashing.

**Files to modify:**
- `frontend/src/api.js`

**Changes:**

Replace single-entry eviction with batch eviction (evict ~20% when limit is reached):

```javascript
// Current:
const keys = Object.keys(_etagCache);
if (keys.length > 200) {
  delete _etagCache[keys[0]];
}

// New:
const keys = Object.keys(_etagCache);
if (keys.length > 200) {
  // Evict oldest 20% to avoid thrashing
  const evictCount = Math.ceil(keys.length * 0.2);
  for (let i = 0; i < evictCount; i++) {
    delete _etagCache[keys[i]];
  }
}
```

**Impact:** Reduces cache thrashing when many endpoints are polled.

**Breaking changes:** None.

- [ ] **4.6 Done**

---

## Phase 5: Testing Improvements

### 5.1 Add authentication and RBAC tests (TG-1, TG-3)

**Finding:** JWT auth, RBAC, and user management are completely untested. All tests use legacy token auth.

**Files to create:**
- `backend/tests/test_auth.py`

**Tests to implement:**
1. Login with valid credentials returns JWT token
2. Login with invalid credentials returns 401
3. Login rate limiting (if Phase 2.1 is done)
4. JWT token authenticates API requests
5. Expired JWT token returns 401
6. Role-based access: admin can create users, viewer cannot
7. Role-based access: operator can create credentials, viewer cannot
8. Password complexity validation (if Phase 2.2 is done)
9. `get_current_user` returns correct user info

**Test fixtures needed:**
- Add JWT-based auth fixture to `conftest.py`:
```python
@pytest.fixture
def jwt_headers(db):
    """Create a test user and return JWT auth headers."""
    from shared.auth import create_token, hash_password
    user = User(username="testadmin", email="test@test.com",
                hashed_pw=hash_password("TestPass123"), role="admin", is_active=True)
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_token(user.id, user.username, user.role)
    return {"Authorization": f"Bearer {token}"}
```

**Impact:** Covers critical authentication paths that are currently untested.

- [x] **5.1 Done**

---

### 5.2 Add bulk import/export tests (TG-1)

**Finding:** Bulk import/export is untested, including the encryption fix from Phase 1.4.

**Files to create:**
- `backend/tests/test_bulk.py`

**Tests to implement:**
1. Bulk export credentials returns masked passwords
2. Bulk export profiles returns masked passwords
3. Bulk import credentials encrypts passwords (verifies CB-1 fix)
4. Bulk import with CSV format
5. Bulk import with JSON format
6. Bulk import dry run does not modify database
7. Bulk import with invalid data returns errors
8. Bulk import updates existing credentials by IP match
9. Bulk import new credentials are inserted
10. Community strings are masked in export (Phase 2.3 fix)

**Impact:** Verifies the critical CB-1 fix and export masking.

- [x] **5.2 Done**

---

### 5.3 Add config import/export tests (TG-1)

**Finding:** Config import/export untested, including encryption concerns.

**Files to create:**
- `backend/tests/test_config.py`

**Tests to implement:**
1. Config export masks passwords
2. Config import encrypts passwords (verifies Phase 1.4 fix)
3. Config import with invalid JSON returns error
4. Config import settings are upserted correctly
5. Config import dry run does not modify database
6. Config export includes all settings, profiles, credentials

**Impact:** Verifies config import/export integrity.

- [x] **5.3 Done**

---

### 5.4 Fix test database to use proper JSONB handling (TG-2)

**Finding:** Tests use SQLite with JSONB patched to JSON, hiding PostgreSQL-specific behavior.

**Files to modify:**
- `backend/tests/conftest.py`

**Changes:**

This is a known trade-off. Full PostgreSQL testing requires a running PostgreSQL instance, which increases CI complexity. For now, document the limitation and add a marker for PostgreSQL-specific tests:

```python
# Add to conftest.py:
import pytest

def pytest_configure(config):
    config.addinivalue_line(
        "markers", "requires_postgres: test requires PostgreSQL (skipped with SQLite)"
    )
```

Tests that exercise PostgreSQL-specific features (JSONB operators, CASCADE specifics) should be marked with `@pytest.mark.requires_postgres` and skipped by default.

**Impact:** Makes the testing limitation explicit and prepares for future PostgreSQL test integration.

- [x] **5.4 Done**

---

### 5.5 Improve test coverage tracking

**Finding:** ~20 tests covering ~2% of the codebase.

**Changes:**

Add pytest-cov configuration to `backend/pytest.ini`:
```ini
[pytest]
addopts = --cov=. --cov-report=term-missing --cov-fail-under=10
```

The `--cov-fail-under=10` sets a low initial bar that can be gradually increased as tests are added. As Phase 5.1-5.3 tests are added, increase this threshold.

**Files to modify:**
- `backend/pytest.ini`
- `backend/requirements.txt` (add `pytest-cov` if not present)

**Impact:** Makes test coverage visible and establishes a baseline.

- [x] **5.5 Done**

---

## Summary

| Phase | Items | Estimated Scope |
|-------|-------|-----------------|
| Phase 1: Critical Security | 4 items (1.1-1.4) | Small-medium changes across 5 files + 1 new file |
| Phase 2: High-Priority Bugs | 6 items (2.1-2.6) | Small changes across 5 files |
| Phase 3: Medium Improvements | 7 items (3.1-3.7) | Small changes, mostly verification |
| Phase 4: Low Enhancements | 6 items (4.1-4.6) | Small-medium changes |
| Phase 5: Testing | 5 items (5.1-5.5) | 3 new test files, config changes |

**Total checklist items:** 28

**Not addressed in this plan (deferred to backlog):**
- CQ-2: Refactoring scan_engine.py into modules (large effort, no immediate risk)
- CQ-3: Migrating from inline CSS (large effort, aesthetic only)
- CQ-5: TypeScript migration (large effort, no immediate risk)
- CQ-8: Scanner plugin discovery (low priority, current approach works)
- AD-1: Dual state management (architectural, works correctly)
- AD-2: Thread-based scheduler to Celery Beat migration (medium effort, works with Redis locking)
- AD-3: Scan engine / router coupling (works with lazy imports)
- SEC-5: WebSocket token in query string (medium effort, low practical risk with TLS)
- SEC-10: CSRF protection (mitigated by Bearer token / localStorage approach)
- PC-1/PC-2: Topology performance optimization (premature until scale issues are observed)
- FE-1/FE-3/FE-5: Frontend UX polish items

---

*End of Implementation Plan*
