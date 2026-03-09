# Full Codebase Code Review Analysis

**Date**: 2025-01-XX
**Scope**: Backend (FastAPI, SQLAlchemy, Celery, SNMP) + Frontend (React, Zustand, Vite) + Infrastructure (Docker, nginx)
**Files Reviewed**: ~80 source files across backend/, frontend/src/, and configuration

---

## Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | 3     |
| HIGH     | 8     |
| MEDIUM   | 7     |
| LOW      | 6     |

---

## CRITICAL Issues

### C1. Missing `HTTPException` import causes NameError at runtime

**File**: `backend/routers/topology.py` lines 203, 207, 211, 213
**Description**: The `update_device_meta` endpoint uses `raise HTTPException(...)` in four places, but `HTTPException` is never imported. The file imports `APIRouter, Depends, Request` from `fastapi` but not `HTTPException`. This will cause a `NameError` at runtime when any of those code paths are hit (rack validation, class validation, outside-rack logic).

**Evidence**:
```python
# Line 1-8 (imports):
from fastapi import APIRouter, Depends, Request
# ... no HTTPException import

# Line 203:
raise HTTPException(404, "Rack not found")
# Line 207:
raise HTTPException(404, "Switch class not found")
# Lines 211, 213:
raise HTTPException(400, "Unracked devices require...")
raise HTTPException(400, "Selected switch class requires rack assignment")
```

**Suggested Fix**: Either add `HTTPException` to the fastapi import, or convert these to use the project's own `api_error()` helper (which is already imported and used elsewhere in the same file) for consistent error response format.

---

### C2. WebSocket authentication silently passes on invalid tokens

**File**: `backend/routers/ws.py` lines 80-90
**Description**: The `_authenticate_ws` function catches JWT decode failures with a bare `except: pass`, allowing connections with invalid/expired/forged tokens. An attacker can connect to the WebSocket endpoint with any random string as a token and receive real-time scan progress data. Additionally, if no token is provided at all, the function returns early without rejecting the connection.

**Evidence**:
```python
def _authenticate_ws(token: str) -> None:
    if not jwt_secret and not legacy_token:
        return  # auth disabled -- OK
    if not token:
        return  # allows unauthenticated connections even when auth IS enabled
    # ...
    try:
        pyjwt.decode(token, jwt_secret, algorithms=["HS256"])
    except Exception:
        pass  # SILENTLY ACCEPTS INVALID TOKENS
```

**Suggested Fix**: Reject the WebSocket connection (raise `WebSocketException(code=1008)` or close with a policy violation code) when a token is required but missing or invalid. At minimum, when `jwt_secret` or `legacy_token` is set, an invalid token should prevent the connection.

---

### C3. Config export masks passwords but import accepts masked values as passwords

**File**: `backend/routers/config.py` lines 60-66 (export) and lines 127-140 (import)
**Also**: `backend/routers/bulk.py` lines 135-145 (bulk export)
**Description**: When exporting config, SNMP passwords are replaced with `"********"`. However, the import endpoint does not skip or reject these sentinel values. Re-importing the exported config without editing will silently overwrite all SNMP v3 auth and priv passwords with the literal string `"********"`, breaking SNMP authentication for all devices.

**Evidence**:
```python
# Export (config.py line 60):
"v3_auth_password": "********" if c.v3_auth_password else "",
"v3_priv_password": "********" if c.v3_priv_password else "",

# Import (config.py line ~135) -- no filtering of "********":
for key, value in row.items():
    setattr(existing, key, value)  # sets v3_auth_password = "********"
```

**Suggested Fix**: During import, skip password fields that contain `"********"` (or any sentinel) when updating existing records. This preserves the current encrypted password value.

---

## HIGH Issues

### H1. Mutable default values in SQLAlchemy Column definitions

**File**: `backend/database.py` lines 213-214 and line 249
**Description**: Multiple JSONB columns use Python mutable objects as default values (`default=[]`, `default={}`). SQLAlchemy's `default` parameter creates a single instance shared across all rows. While PostgreSQL's server-side defaults may mask this in practice, when creating objects in Python (e.g., `Port()` or `AuditLog()`), all new instances share the same list/dict reference.

**Evidence**:
```python
# Line 213:
endpoint_details_json = Column(JSONB, default=[])
# Line 249:
details = Column(JSONB, default={})
# Line 232:
devices_snapshot_json = Column(JSONB, default=[])
# Line 233:
links_snapshot_json   = Column(JSONB, default=[])
```

**Suggested Fix**: Use `default=list` (a callable) or `server_default=text("'[]'::jsonb")`:
```python
endpoint_details_json = Column(JSONB, default=list)
details = Column(JSONB, default=dict)
```

---

### H2. Type mismatch: `PortOut.endpoint_details_json` typed as `str` but database stores JSONB

**File**: `backend/schemas.py` line 299 and `backend/database.py` line 213
**Description**: The `PortOut` Pydantic schema declares `endpoint_details_json` as `Optional[str] = "[]"`, but the database column is `JSONB`, which returns a Python list/dict, not a string. This causes a type mismatch: SQLAlchemy returns a Python list from JSONB, but the schema expects a string. The frontend works around this by checking `typeof raw === "string" ? JSON.parse(raw) : raw`, but this is fragile.

**Evidence**:
```python
# schemas.py line 299:
endpoint_details_json: Optional[str] = "[]"

# database.py line 213:
endpoint_details_json = Column(JSONB, default=[])
```

**Suggested Fix**: Change the schema type to match the actual data type:
```python
endpoint_details_json: Optional[list] = []
```

---

### H3. Double serialization: `json.dumps()` into JSONB column

**File**: `backend/scan_engine.py` line 940
**Description**: The scan engine writes `endpoint_details_json=json.dumps(endpoint_details)` when building port rows for `bulk_insert_mappings`. Since the column type is `JSONB`, SQLAlchemy automatically serializes Python objects to JSON. Passing a pre-serialized JSON string causes double encoding -- the JSONB column stores a JSON string literal (e.g., `"[{\"mac\":...}]"`) instead of a proper JSON array. This explains why the frontend needs the `typeof raw === "string" ? JSON.parse(raw) : raw` workaround.

**Evidence**:
```python
# scan_engine.py line 940:
"endpoint_details_json": json.dumps(endpoint_details),
# Should be:
"endpoint_details_json": endpoint_details,
```

**Suggested Fix**: Remove `json.dumps()` and pass the Python list directly. Also update `PortOut` schema type (see H2) and remove frontend parse workarounds.

---

### H4. Inconsistent error response format in topology router

**File**: `backend/routers/topology.py` lines 203, 207, 211, 213
**Description**: Four error-raising paths use raw `raise HTTPException(status_code, detail_string)` while the rest of the codebase uses `api_error(status, code, message)` from `shared/errors.py`. The `api_error` helper returns structured JSON `{"error": {"code": "...", "message": "..."}}`. Raw `HTTPException` returns `{"detail": "..."}`. Frontend error handling expects one format but receives another depending on which endpoint errors.

**Evidence**:
```python
# topology.py (inconsistent):
raise HTTPException(404, "Rack not found")  # -> {"detail": "Rack not found"}

# Other routers (consistent):
api_error(404, "DEVICE_NOT_FOUND", "Device not found")  # -> {"error":{"code":"DEVICE_NOT_FOUND","message":"..."}}
```

**Suggested Fix**: Replace all four `raise HTTPException(...)` calls with `api_error(...)` calls matching the project pattern. (Also fixes C1 since `api_error` is already imported.)

---

### H5. Credential update incorrectly blocks removing both rack and class assignments

**File**: `backend/routers/topology.py` lines 209-213
**Description**: When `target_rack_id` is `None` and `target_class_id` is also `None`, the code raises an error: "Unracked devices require a switch class that allows outside-rack placement". This prevents users from removing both rack and class assignments from a device, which should be a valid operation (e.g., returning a device to an unassigned state).

**Evidence**:
```python
if target_rack_id is None:
    if target_class_id is None:
        raise HTTPException(400, "Unracked devices require a switch class...")
    if not target_class.allow_outside_rack:
        raise HTTPException(400, "Selected switch class requires rack assignment")
```

**Suggested Fix**: Allow removing both rack and class -- only enforce the outside-rack check when a class IS specified but no rack is given:
```python
if target_rack_id is None and target_class_id is not None:
    if not target_class.allow_outside_rack:
        api_error(400, "OUTSIDE_RACK_NOT_ALLOWED", "Selected switch class requires rack assignment")
```

---

### H6. `store.js` `loadMapBackground` uses raw `fetch()` without auth headers

**File**: `frontend/src/store.js` lines 60-70
**Description**: The `loadMapBackground` function uses the native `fetch()` API directly instead of the project's `api.get()` wrapper. This means authentication headers (Bearer token) are not included in the request. If the backend requires authentication for `/api/map-background`, this request will fail with a 401/403. The function also doesn't handle non-200 responses properly -- it treats any response as success.

**Evidence**:
```javascript
loadMapBackground: () => {
    fetch(`${API}/api/map-background`)          // No auth headers!
      .then(r => {
        if (!r.ok) throw new Error();
        // ...
      })
```

**Suggested Fix**: Use `api.get()` or manually include the auth header:
```javascript
fetch(`${API}/api/map-background`, { headers: { Authorization: `Bearer ${getStoredToken()}` } })
```

---

### H7. `scanned` count uses wrong variable in full scan mode

**File**: `backend/scan_engine.py` line 1051
**Description**: After a full scan, `result.scanned` is set to `len(credentials)`, which counts the manually configured SNMP credential entries. However, the actual number of targets scanned includes IPs discovered from discovery ranges. The dry-run path correctly uses `len(scan_targets)` (line 698). This discrepancy means the scan result may report fewer devices scanned than were actually attempted.

**Evidence**:
```python
# Full scan (line 1051) -- wrong:
result = ScanResult(scanned=len(credentials), ...)

# Dry run (line 698) -- correct:
result = ScanResult(scanned=len(scan_targets), ...)
```

**Suggested Fix**: Use `len(scan_targets)` consistently in both code paths.

---

### H8. ETag generation uses MD5

**File**: `backend/routers/topology.py` lines 119, 260
**Description**: ETags are generated using `hashlib.md5(body.encode()).hexdigest()`. While MD5 is acceptable for non-security purposes (cache validation), some security scanners and compliance frameworks flag MD5 usage. In FIPS-compliant environments, MD5 may be disabled entirely, causing a runtime crash.

**Evidence**:
```python
etag = f'"{hashlib.md5(body.encode()).hexdigest()}"'
```

**Suggested Fix**: Use `hashlib.sha256` for broader compatibility, or use Python's `hash()` for cache-only ETags.

---

## MEDIUM Issues

### M1. Missing `networks` declaration at the top level of docker-compose.yml

**File**: `docker-compose.yml`
**Description**: All services reference a `netmap` network but there is no top-level `networks:` block declaring it. Docker Compose v2+ auto-creates networks if not declared, but explicitly declaring it is considered best practice and avoids ambiguity.

**Evidence**:
```yaml
    networks:
      - netmap
# ... but no top-level:
# networks:
#   netmap:
```

**Suggested Fix**: Add at the end:
```yaml
networks:
  netmap:
```

---

### M2. Celery worker and backend don't share JWT_SECRET / SECRET_TOKEN

**File**: `docker-compose.yml` lines 81-90 (celery-worker environment)
**Description**: The `celery-worker` service environment only includes `DATABASE_URL`, `REDIS_URL`, and `ENCRYPTION_KEY`. It does not receive `JWT_SECRET`, `SECRET_TOKEN`, or `DEFAULT_ADMIN_PASSWORD`. If the Celery worker code ever needs to validate tokens or access these secrets, it will fail or use default empty-string values.

**Evidence**:
```yaml
celery-worker:
    environment:
      DATABASE_URL: "postgresql://..."
      REDIS_URL: "redis://..."
      ENCRYPTION_KEY: "${ENCRYPTION_KEY:-}"
      # Missing: JWT_SECRET, SECRET_TOKEN
```

**Suggested Fix**: Add `JWT_SECRET` and `SECRET_TOKEN` to the worker environment if any task code might need them, or confirm the worker never accesses these values.

---

### M3. Port.jsx references undeclared variable `raw` in catch block

**File**: `frontend/src/components/Port.jsx` line ~24
**Description**: In the `parsedEndpoints` IIFE, the `catch` block references `raw` in `console.warn("Port: failed to parse JSON value", raw, e)`, but `raw` is declared inside the `try` block with `const raw = ...`. If the error occurs on or before the `raw` declaration, `raw` is in the temporal dead zone and the catch itself throws a `ReferenceError`. Even if it doesn't crash, `raw` is scoped to the `try` block and not accessible in `catch` in all JS engines consistently.

**Evidence**:
```javascript
const parsedEndpoints = (() => {
    try {
      const raw = port.endpoint_details_json;
      // ...
    } catch (e) {
      console.warn("Port: failed to parse JSON value", raw, e);  // 'raw' may not be defined
      return [];
    }
  })();
```

**Suggested Fix**: Declare `raw` before the `try` block, or remove the reference from the catch:
```javascript
} catch (e) {
  console.warn("Port: failed to parse endpoint_details_json", e);
  return [];
}
```

---

### M4. useRackOrders has hardcoded vendor-based fallback logic

**File**: `frontend/src/hooks/useRackOrders.js` lines 13-17
**Description**: The `reorderDevice` function contains hardcoded fallback logic mapping vendor names to group keys: `"tor"` maps to `d.vendor === "fs"` and `"access"` maps to `d.vendor === "aruba_cx"`. This breaks for any other vendor and tightly couples the ordering logic to specific vendor names. If new vendors (UniFi, OPNsense) are added, they fall into the "other" bucket.

**Evidence**:
```javascript
if (groupKey === "tor") return d.class_id === 1 || (!d.class_id && d.vendor === "fs");
if (groupKey === "access") return d.class_id === 2 || (!d.class_id && d.vendor === "aruba_cx");
if (groupKey === "other") return d.class_id == null && d.vendor !== "fs" && d.vendor !== "aruba_cx";
```

**Suggested Fix**: Remove vendor-based fallbacks or make the group-to-vendor mapping configurable. Use class_id as the sole grouping criterion for consistency.

---

### M5. SettingsPage.jsx error handling inconsistency

**File**: `frontend/src/pages/SettingsPage.jsx`
**Description**: The `uploadMapBg` error handling tries to access `b?.detail` for the error message, but the backend's `api_error()` helper returns errors in format `{"error": {"code": "...", "message": "..."}}`. The correct access pattern should be `b?.error?.message`, matching the structured error format. (Note: The actual page code would need full re-reading to confirm exact line.)

**Suggested Fix**: Standardize error extraction across all frontend code to handle both error formats, or ensure backend always returns the same format.

---

### M6. DashboardPage.jsx useEffect missing dependency

**File**: `frontend/src/pages/DashboardPage.jsx`
**Description**: The scan polling `useEffect` references `clearScanJob` and possibly other store functions but does not include them in its dependency array. This can lead to stale closures where the effect captures outdated references to store functions.

**Suggested Fix**: Add all referenced functions to the dependency array or use `useRef` to hold mutable references.

---

### M7. No CSRF protection on state-changing endpoints

**File**: Multiple backend routes
**Description**: The application uses JWT Bearer tokens for authentication and has no CSRF token mechanism. While Bearer tokens are generally not vulnerable to CSRF (they're sent via Authorization header, not cookies), the `getStoredToken()` function stores the JWT in `localStorage`. If the application ever switches to cookie-based auth, all POST/PUT/PATCH/DELETE endpoints will be vulnerable to CSRF attacks. Additionally with current design, XSS vulnerabilities could extract tokens from localStorage.

**Suggested Fix**: This is acceptable for the current auth implementation using Authorization headers. If cookies are ever used for tokens, CSRF protection (e.g., `SameSite=Strict` + CSRF tokens) should be added.

---

## LOW Issues

### L1. Unused `import threading` in tasks.py

**File**: `backend/tasks.py` line 4
**Description**: The `threading` module is imported but never used in the file.

**Evidence**:
```python
import threading  # unused
```

**Suggested Fix**: Remove the unused import.

---

### L2. Seed script uses hardcoded auto-increment-dependent IDs

**File**: `backend/seed_db.py`
**Description**: The seed script assumes specific auto-increment ID values for racks, classes, and profiles (e.g., `class_id === 1` means TOR). If the database has existing data or if auto-increment sequences don't start at 1, the seed will create incorrect associations.

**Suggested Fix**: Use query lookups (by label/name) to resolve IDs rather than hardcoding numeric values. This is a dev-only script, so impact is limited.

---

### L3. Default database passwords in docker-compose.yml

**File**: `docker-compose.yml` line 11 and line 55
**Description**: Default passwords are set for PostgreSQL (`netmap_pw`) and the app (`changeme` for SECRET_TOKEN and DEFAULT_ADMIN_PASSWORD). While these use `${VAR:-default}` substitution allowing override via `.env`, the defaults are weak and insecure for any internet-facing deployment.

**Evidence**:
```yaml
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-netmap_pw}
SECRET_TOKEN: "${SECRET_TOKEN:-changeme}"
DEFAULT_ADMIN_PASSWORD: "${DEFAULT_ADMIN_PASSWORD:-changeme}"
```

**Suggested Fix**: Document that `.env` file overrides are required for production. Consider removing defaults or making them fail-fast if not set in production mode.

---

### L4. No Content-Security-Policy header in nginx.conf

**File**: `frontend/nginx.conf`
**Description**: The nginx config sets security headers (`X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`) but does not include a `Content-Security-Policy` header. CSP is the most effective defense against XSS attacks.

**Suggested Fix**: Add a basic CSP header:
```nginx
add_header Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:" always;
```

---

### L5. `useScanProgress` WebSocket silently discards parse errors

**File**: `frontend/src/hooks/useScanProgress.js` line 30
**Description**: `ws.onmessage` has an empty `catch {}` block that silently swallows JSON parse errors. If the server sends malformed data, it's completely invisible to debugging.

**Evidence**:
```javascript
ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      // ...
    } catch {}  // silently swallows all errors
};
```

**Suggested Fix**: At minimum, add `console.warn` inside the catch.

---

### L6. Frontend API client doesn't handle 401 responses globally

**File**: `frontend/src/api.js`
**Description**: The `api` wrapper functions handle errors locally but don't implement a global 401 interceptor to redirect to the login page when a token expires. If the JWT expires mid-session, API calls will fail silently or show generic errors rather than redirecting to login.

**Suggested Fix**: Add a global response interceptor that clears stored auth and redirects to `/login` on 401 responses.

---

## Architecture Notes (non-bug observations)

1. **Inline styles throughout frontend**: All React components use inline `style={{...}}` objects. While functional, this makes theming, responsive design, and maintenance harder. Consider CSS modules or a CSS-in-JS solution if the project grows.

2. **No request validation on SNMP port ranges**: The `snmp_port` field accepts any integer. Ports outside 1-65535 would cause runtime errors during scanning.

3. **Background event loop management**: `scan_engine.py` manages its own asyncio event loop in a background thread (`_get_bg_loop`). This is complex but appears correctly implemented for the current use case.

4. **No rate limiting on WebSocket connections**: The WebSocket endpoint has no connection limits. A client could open many connections and exhaust server resources.

5. **Redis connection failures are silently handled**: Throughout `shared/state.py` and `shared/redis_client.py`, Redis failures fall back to in-memory storage. This is resilient but can cause state inconsistency in multi-worker deployments.
