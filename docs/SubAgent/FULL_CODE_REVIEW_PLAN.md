# Full Code Review - Implementation Plan

**Based on**: docs/SubAgent/FULL_CODE_REVIEW_ANALYSIS.md
**Scope**: Fix all CRITICAL (3) and HIGH (8) issues. MEDIUM and LOW listed as optional.

---

## Fix Groups

### Group 1: Topology Router - HTTPException and Error Handling (C1 + H4 + H5)

These three issues are in the same file and same function (`update_device_meta`). Fixing them together avoids conflicting edits.

#### Fix 1.1 - C1 + H4: Replace HTTPException with api_error() (CRITICAL + HIGH)

- **File**: `backend/routers/topology.py`
- **Lines**: 200, 204, 209, 211
- **Why**: `HTTPException` is not imported (causes NameError at runtime). The project convention uses `api_error()` which is already imported. Switching to `api_error()` fixes both the missing import and the inconsistent error format.
- **Old code** (lines 200-213):
```python
    if target_rack_id is not None and not db.query(RackModel).filter(RackModel.id == target_rack_id).first():
        raise HTTPException(404, "Rack not found")

    target_class = None
    if target_class_id is not None:
        target_class = db.query(SwitchClassModel).filter(SwitchClassModel.id == target_class_id).first()
        if not target_class:
            raise HTTPException(404, "Switch class not found")

    if target_rack_id is None:
        if target_class_id is None:
            raise HTTPException(400, "Unracked devices require a switch class that allows outside-rack placement")
        if not target_class.allow_outside_rack:
            raise HTTPException(400, "Selected switch class requires rack assignment")
```
- **New code**:
```python
    if target_rack_id is not None and not db.query(RackModel).filter(RackModel.id == target_rack_id).first():
        api_error(404, "RACK_NOT_FOUND", "Rack not found")

    target_class = None
    if target_class_id is not None:
        target_class = db.query(SwitchClassModel).filter(SwitchClassModel.id == target_class_id).first()
        if not target_class:
            api_error(404, "SWITCH_CLASS_NOT_FOUND", "Switch class not found")

    if target_rack_id is None and target_class_id is not None:
        if not target_class.allow_outside_rack:
            api_error(400, "OUTSIDE_RACK_NOT_ALLOWED", "Selected switch class requires rack assignment")
```
- **Also fixes H5**: The old logic blocked removing both rack and class (target_rack_id=None + target_class_id=None raised an error). Now only validates when a class IS specified without a rack. Removing both assignments is a valid "unassign" operation.
- **Dependencies**: None.

---

### Group 2: WebSocket Authentication (C2)

#### Fix 2.1 - C2: Reject invalid/missing tokens when auth is enabled (CRITICAL)

- **File**: `backend/routers/ws.py`
- **Lines**: 78-97
- **Why**: When auth is enabled (JWT_SECRET or SECRET_TOKEN is set), the function silently allows connections with no token or invalid tokens. An attacker can connect with any string and receive real-time scan data.
- **Old code**:
```python
def _authenticate_ws(token: str) -> None:
    """Best-effort token validation for WebSocket connections.

    WebSockets cannot use standard HTTP auth headers, so the token is
    passed as a query parameter. If auth is disabled on the server,
    this is a no-op.
    """
    import os
    jwt_secret = os.getenv("JWT_SECRET", os.getenv("SECRET_TOKEN", ""))
    legacy_token = os.getenv("SECRET_TOKEN", "")

    if not jwt_secret and not legacy_token:
        return  # auth disabled

    if not token:
        return  # allow unauthenticated when no token provided (matches REST behavior)

    if legacy_token and token == legacy_token:
        return

    try:
        import jwt as pyjwt
        pyjwt.decode(token, jwt_secret, algorithms=["HS256"])
    except Exception:
        pass  # don't reject -- keep consistent with REST fallback behavior
```
- **New code**:
```python
def _authenticate_ws(token: str) -> None:
    """Validate token for WebSocket connections.

    WebSockets cannot use standard HTTP auth headers, so the token is
    passed as a query parameter. If auth is disabled on the server,
    this is a no-op.
    """
    import os
    from fastapi import WebSocketException

    jwt_secret = os.getenv("JWT_SECRET", os.getenv("SECRET_TOKEN", ""))
    legacy_token = os.getenv("SECRET_TOKEN", "")

    if not jwt_secret and not legacy_token:
        return  # auth disabled

    if not token:
        raise WebSocketException(code=1008, reason="Authentication required")

    if legacy_token and token == legacy_token:
        return

    try:
        import jwt as pyjwt
        pyjwt.decode(token, jwt_secret, algorithms=["HS256"])
    except Exception:
        raise WebSocketException(code=1008, reason="Invalid or expired token")
```
- **Why this is correct**: WebSocket code 1008 is the standard "policy violation" close code. `WebSocketException` is raised before `ws.accept()` is called (the function is called on line 55, before accept on line 57), so it properly rejects the connection. When auth is disabled (no secret set), behavior is unchanged.
- **Dependencies**: None.

---

### Group 3: Config Import Password Sentinel (C3)

#### Fix 3.1 - C3: Skip masked password fields during import (CRITICAL)

- **File**: `backend/routers/config.py`
- **Lines**: 137-143 (profile update loop) and 148-153 (credential update loop)
- **Why**: Re-importing an exported config without editing would overwrite all SNMP passwords with the literal string `"********"`, breaking SNMP authentication.

##### Fix 3.1a - Profile import: skip sentinel passwords

- **Old code** (lines 137-142):
```python
        for row in valid_profiles:
            existing = db.query(SnmpProfile).filter(SnmpProfile.label == row["label"]).first()
            if existing:
                for key, value in row.items():
                    setattr(existing, key, value)
                updated["profiles"] += 1
```
- **New code**:
```python
        _PASSWORD_MASK = "********"

        for row in valid_profiles:
            existing = db.query(SnmpProfile).filter(SnmpProfile.label == row["label"]).first()
            if existing:
                for key, value in row.items():
                    if key in ("v3_auth_password", "v3_priv_password") and value == _PASSWORD_MASK:
                        continue
                    setattr(existing, key, value)
                updated["profiles"] += 1
```

##### Fix 3.1b - Credential import: skip sentinel passwords

- **Old code** (lines 148-153):
```python
        for row in valid_credentials:
            existing = db.query(Credential).filter(Credential.ip == row["ip"]).first()
            if existing:
                for key, value in row.items():
                    setattr(existing, key, value)
                updated["credentials"] += 1
```
- **New code**:
```python
        for row in valid_credentials:
            existing = db.query(Credential).filter(Credential.ip == row["ip"]).first()
            if existing:
                for key, value in row.items():
                    if key in ("v3_auth_password", "v3_priv_password") and value == _PASSWORD_MASK:
                        continue
                    setattr(existing, key, value)
                updated["credentials"] += 1
```

#### Fix 3.2 - C3: Same fix for bulk import

- **File**: `backend/routers/bulk.py`
- **Lines**: 185-190 (credential update) and 195-200 (profile update)
- **Why**: Bulk import has the same vulnerability -- exported masked passwords can be re-imported.

##### Fix 3.2a - Bulk credential import

- **Old code** (lines 185-190):
```python
            for payload in valid_rows:
                existing = db.query(Credential).filter(Credential.ip == payload["ip"]).first()
                if existing:
                    for key, value in payload.items():
                        setattr(existing, key, value)
                    updated += 1
```
- **New code**:
```python
            _PASSWORD_MASK = "********"
            for payload in valid_rows:
                existing = db.query(Credential).filter(Credential.ip == payload["ip"]).first()
                if existing:
                    for key, value in payload.items():
                        if key in ("v3_auth_password", "v3_priv_password") and value == _PASSWORD_MASK:
                            continue
                        setattr(existing, key, value)
                    updated += 1
```

##### Fix 3.2b - Bulk profile import

- **Old code** (lines 195-200):
```python
            for payload in valid_rows:
                existing = db.query(SnmpProfile).filter(SnmpProfile.label == payload["label"]).first()
                if existing:
                    for key, value in payload.items():
                        setattr(existing, key, value)
                    updated += 1
```
- **New code**:
```python
            for payload in valid_rows:
                existing = db.query(SnmpProfile).filter(SnmpProfile.label == payload["label"]).first()
                if existing:
                    for key, value in payload.items():
                        if key in ("v3_auth_password", "v3_priv_password") and value == _PASSWORD_MASK:
                            continue
                        setattr(existing, key, value)
                    updated += 1
```

- **Dependencies**: None.

---

### Group 4: JSONB Double Serialization and Type Mismatch (H1 + H2 + H3)

These three issues form a chain: H1 (mutable defaults) -> H3 (double serialization) -> H2 (schema type mismatch). Fixing them together ensures consistency from database to API response.

#### Fix 4.1 - H1: Use callable defaults for JSONB columns

- **File**: `backend/database.py`
- **Lines**: 196, 232, 233, 249
- **Old code**:
```python
endpoint_details_json = Column(JSONB, default=[])
```
```python
devices_snapshot_json = Column(JSONB, default=[])
links_snapshot_json   = Column(JSONB, default=[])
```
```python
details = Column(JSONB, default={})
```
- **New code**:
```python
endpoint_details_json = Column(JSONB, default=list)
```
```python
devices_snapshot_json = Column(JSONB, default=list)
links_snapshot_json   = Column(JSONB, default=list)
```
```python
details = Column(JSONB, default=dict)
```
- **Why**: Mutable defaults (`[]`, `{}`) are shared across all instances. Using callables (`list`, `dict`) creates a new instance per row.
- **Dependencies**: None, but do this before H3 to ensure new rows get correct defaults.

#### Fix 4.2 - H3: Remove json.dumps() for JSONB column

- **File**: `backend/scan_engine.py`
- **Line**: 940
- **Old code**:
```python
"endpoint_details_json": json.dumps(endpoint_details),
```
- **New code**:
```python
"endpoint_details_json": endpoint_details,
```
- **Why**: The column is `JSONB` -- SQLAlchemy handles serialization automatically. Pre-serializing with `json.dumps()` causes double encoding: the JSONB column stores a JSON string literal instead of a proper JSON array. This is the root cause of the frontend needing the `typeof raw === "string" ? JSON.parse(raw) : raw` workaround.
- **Dependencies**: H2 schema should be updated at the same time to match.

#### Fix 4.3 - H2: Fix PortOut schema type for endpoint_details_json

- **File**: `backend/schemas.py`
- **Lines**: 299 and the `_coerce_nulls` validator (line 308)
- **Old code**:
```python
endpoint_details_json: Optional[str] = "[]"
```
(and in `_coerce_nulls` defaults dict):
```python
"endpoint_details_json": "[]",
```
- **New code**:
```python
endpoint_details_json: Optional[list] = []
```
(and in `_coerce_nulls` defaults dict):
```python
"endpoint_details_json": [],
```
- **Why**: The JSONB column returns a Python list, not a string. The schema type should match.
- **Dependencies**: Must be done together with H3 (Fix 4.2). After H3, the column stores proper JSON arrays and existing data will be correct for new scans. Old rows with double-encoded strings would need a one-time data migration (not strictly required if a new scan overwrites port data).

#### Fix 4.4 - Frontend cleanup: Remove JSON.parse workaround

- **File**: `frontend/src/components/Port.jsx`
- **Lines**: 15-26
- **Old code**:
```javascript
  const parsedEndpoints = (() => {
    try {
      const raw = port.endpoint_details_json;
      if (!raw) return [];
      const value = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Array.isArray(value) ? value : [];
    } catch (e) {
      console.warn("Port: failed to parse JSON value", raw, e);
      return [];
    }
  })();
```
- **New code**:
```javascript
  const parsedEndpoints = (() => {
    const raw = port.endpoint_details_json;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
      const value = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Array.isArray(value) ? value : [];
    } catch (e) {
      console.warn("Port: failed to parse endpoint_details_json", e);
      return [];
    }
  })();
```
- **Why**: After H3 fix, the API returns a proper JSON array (not a string). The fast path handles the normal case directly. The fallback try/catch handles any legacy data that might still be double-encoded. Also fixes M3 (`raw` variable scoping issue in catch block).
- **Dependencies**: Deploy backend fix (H3) first or simultaneously. The frontend code handles both formats gracefully during transition.

---

### Group 5: Store loadMapBackground Auth (H6)

#### Fix 5.1 - H6: Use auth headers in loadMapBackground

- **File**: `frontend/src/store.js`
- **Lines**: 62-74
- **Old code**:
```javascript
  loadMapBackground: () => {
    fetch(`${API}/api/map-background`)
      .then(r => {
        if (!r.ok) throw new Error();
        const url = `${API}/api/map-background?v=${Date.now()}`;
        set({ bgUrl: url });
        const img = new Image();
        img.onload = () => set({ bgNat: { w: img.naturalWidth, h: img.naturalHeight } });
        img.onerror = () => set({ bgNat: null });
        img.src = url;
      })
      .catch(() => { set({ bgUrl: null, bgNat: null }); });
  },
```
- **New code**:
```javascript
  loadMapBackground: () => {
    fetch(`${API}/api/map-background`, { headers: _getAuthHeader() })
      .then(r => {
        if (!r.ok) throw new Error();
        const url = `${API}/api/map-background?v=${Date.now()}`;
        set({ bgUrl: url });
        const img = new Image();
        img.onload = () => set({ bgNat: { w: img.naturalWidth, h: img.naturalHeight } });
        img.onerror = () => set({ bgNat: null });
        img.src = url;
      })
      .catch(() => { set({ bgUrl: null, bgNat: null }); });
  },
```
- **Why**: The check request uses raw `fetch()` without auth headers, which will fail with 401 if the backend requires authentication. Using `_getAuthHeader()` (already imported at top of store.js via `api.js`) adds the Bearer token.
- **Note**: Verify that `_getAuthHeader` is imported in store.js.
- **Dependencies**: None.

---

### Group 6: Scan Result Count (H7)

#### Fix 6.1 - H7: Use scan_targets length instead of credentials length

- **File**: `backend/scan_engine.py`
- **Line**: 1051
- **Old code**:
```python
    result = ScanResult(
        scanned=len(credentials),
```
- **New code**:
```python
    result = ScanResult(
        scanned=len(scan_targets),
```
- **Why**: `credentials` only counts manually configured entries. `scan_targets` includes IPs from discovery ranges, which is the actual number of targets scanned. The dry-run path already correctly uses `len(scan_targets)`.
- **Dependencies**: None.

---

### Group 7: ETag Hash Algorithm (H8)

#### Fix 7.1 - H8: Replace MD5 with SHA-256 for ETag generation

- **File**: `backend/routers/topology.py`
- **Lines**: 119 and 260
- **Old code** (line 119):
```python
    etag = f'"{hashlib.md5(body.encode()).hexdigest()}"'
```
- **New code** (line 119):
```python
    etag = f'"{hashlib.sha256(body.encode()).hexdigest()[:32]}"'
```
- **Old code** (line 260):
```python
    etag = f'"{hashlib.md5(body.encode()).hexdigest()}"'
```
- **New code** (line 260):
```python
    etag = f'"{hashlib.sha256(body.encode()).hexdigest()[:32]}"'
```
- **Why**: MD5 can be disabled in FIPS-compliant environments, causing a runtime crash. SHA-256 is universally available. Truncating to 32 chars keeps ETag length similar to MD5 (32 hex chars). ETags are for cache validation only, not security.
- **Dependencies**: None.

---

### Group 8: Unused Import (L1 - included because trivial)

#### Fix 8.1 - L1: Remove unused threading import

- **File**: `backend/tasks.py`
- **Line**: 4
- **Old code**:
```python
import threading
```
- **New code**: (remove the line)
- **Why**: `threading` is imported but never used.
- **Dependencies**: None.

---

## Optional Fixes (MEDIUM and LOW)

These are not blocking but should be addressed when convenient:

| ID | Severity | File | Issue | Effort |
|----|----------|------|-------|--------|
| M1 | MEDIUM | `docker-compose.yml` | Missing `networks:` declaration | **Already fixed** - file has `networks: netmap:` block |
| M2 | MEDIUM | `docker-compose.yml` | Celery worker missing JWT_SECRET / SECRET_TOKEN env vars | Low - add 2 env vars if worker needs them |
| M3 | MEDIUM | `frontend/src/components/Port.jsx` | `raw` var scoping in catch block | **Fixed as part of Group 4 (Fix 4.4)** |
| M4 | MEDIUM | `frontend/src/hooks/useRackOrders.js` | Hardcoded vendor-based fallback logic | Medium - needs design decision on grouping strategy |
| M5 | MEDIUM | `frontend/src/pages/SettingsPage.jsx` | Error handling accesses wrong error format (`b?.detail` vs `b?.error?.message`) | Low |
| M6 | MEDIUM | `frontend/src/pages/DashboardPage.jsx` | useEffect missing dependency in scan polling | Low |
| M7 | MEDIUM | Multiple backend routes | No CSRF protection | N/A - acceptable with current Bearer token auth |
| L2 | LOW | `backend/seed_db.py` | Hardcoded auto-increment IDs | Low - dev-only script |
| L3 | LOW | `docker-compose.yml` | Default passwords (`changeme`, `netmap_pw`) | Low - document in README |
| L4 | LOW | `frontend/nginx.conf` | No Content-Security-Policy header | Low |
| L5 | LOW | `frontend/src/hooks/useScanProgress.js` | Empty catch in WebSocket onmessage | Low - add console.warn |
| L6 | LOW | `frontend/src/api.js` | No global 401 interceptor | Medium |

---

## Implementation Order

Execute fix groups in this order to minimize conflicts:

1. **Group 4** (H1 + H2 + H3) - JSONB fixes (database -> scan engine -> schema -> frontend)
2. **Group 1** (C1 + H4 + H5) - Topology router errors
3. **Group 2** (C2) - WebSocket auth
4. **Group 3** (C3) - Config/bulk import password sentinel
5. **Group 5** (H6) - Store auth headers
6. **Group 6** (H7) - Scan result count
7. **Group 7** (H8) - ETag hash
8. **Group 8** (L1) - Unused import

---

## Checklist

- [ ] Fix 4.1 - H1: Mutable JSONB defaults in `database.py` (use `list`/`dict` callables)
- [ ] Fix 4.2 - H3: Remove `json.dumps()` in `scan_engine.py` line 940
- [ ] Fix 4.3 - H2: Change `PortOut.endpoint_details_json` type to `list` in `schemas.py`
- [ ] Fix 4.4 - M3: Update Port.jsx endpoint parsing (fast path + fix catch scoping)
- [ ] Fix 1.1 - C1+H4+H5: Replace HTTPException with api_error() + fix outside-rack logic in `topology.py`
- [ ] Fix 2.1 - C2: Reject invalid/missing WS tokens in `ws.py`
- [ ] Fix 3.1a - C3: Skip password sentinel in config import profiles (`config.py`)
- [ ] Fix 3.1b - C3: Skip password sentinel in config import credentials (`config.py`)
- [ ] Fix 3.2a - C3: Skip password sentinel in bulk import credentials (`bulk.py`)
- [ ] Fix 3.2b - C3: Skip password sentinel in bulk import profiles (`bulk.py`)
- [ ] Fix 5.1 - H6: Add auth headers to `loadMapBackground` in `store.js`
- [ ] Fix 6.1 - H7: Use `len(scan_targets)` in `scan_engine.py` line 1051
- [ ] Fix 7.1 - H8: Replace MD5 with SHA-256 for ETags in `topology.py` (2 locations)
- [ ] Fix 8.1 - L1: Remove unused `import threading` in `tasks.py`
