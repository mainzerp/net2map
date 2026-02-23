# Code Review Implementation Plan – NetMap

**Date:** 2026-02-23  
**Based on:** `docs/SubAgent/CODE_REVIEW_ANALYSIS.md`  
**Author:** Planning agent  

---

## Summary Table

| Severity | Count |
|----------|-------|
| CRITICAL | 3     |
| HIGH     | 16    |
| MEDIUM   | 33    |
| LOW      | 16    |
| **Total**| **68**|

**Recommended implementation order:** Complete all CRITICAL fixes in a single commit before merging any other changes. All CRITICAL issues expose security vulnerabilities accessible to anyone on the LAN.

---

## Priority 1 — CRITICAL (Fix Immediately)

---

### C-1 · Fix invalid CORS configuration
**Ref:** 1.1  
**File:** `backend/main.py` ~line 55  
**Why:** `allow_credentials=True` combined with `allow_origins=["*"]` is rejected by browsers per the CORS spec and would be a full credential-exposure bug if the wildcard were ever narrowed to a real origin.

**What to change:**
- Read the frontend origin from an environment variable (`CORS_ORIGIN`, default `http://localhost:3000`).
- Replace `allow_origins=["*"]` with `allow_origins=[os.getenv("CORS_ORIGIN", "http://localhost:3000")]`.
- Keep `allow_credentials=True` — it is now safe because the origin is explicit.
- Update `docker-compose.yml` to pass `CORS_ORIGIN=http://localhost:3000` (or the actual deployed frontend URL) to the backend service.

```python
# Before
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    ...
)

# After
CORS_ORIGIN = os.getenv("CORS_ORIGIN", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[CORS_ORIGIN],
    allow_credentials=True,
    ...
)
```

---

### C-2 · Mask SNMP credentials in all API responses
**Ref:** 1.2  
**Files:** `backend/schemas.py`, `backend/main.py`  
**Why:** Every `GET /api/credentials`, `GET /api/snmp-profiles`, and config/bulk-export endpoint returns `v3_auth_password` and `v3_priv_password` in plaintext. The API has no authentication; any LAN device can exfiltrate all network passwords.

**What to change:**

1. In `backend/schemas.py`, add a masked output variant for every schema that exposes passwords:

```python
class CredentialOut(CredentialBase):
    id: int
    v3_auth_password: str = ""       # masked — never returned to clients
    v3_priv_password: str = ""       # masked — never returned to clients
    ...

class SnmpProfileOut(SnmpProfileBase):
    id: int
    v3_auth_password: str = ""
    v3_priv_password: str = ""
    ...
```

2. Alternatively, use a Pydantic validator / `@field_serializer` to always replace non-empty passwords with `"***"` in the `Out` schemas:

```python
from pydantic import field_serializer

class CredentialOut(CredentialBase):
    ...
    @field_serializer("v3_auth_password", "v3_priv_password")
    def _mask(self, v: str) -> str:
        return "***" if v else ""
```

3. Verify the `GET /api/config/export` and `GET /api/bulk-export/credentials` endpoints — if they are intended as full exports (e.g. for backup), they must be protected by authentication (see C-3) before passwords are included. Until authentication is in place, mask passwords in these exports as well.

---

### C-3 · Add API authentication (minimum: static token)
**Ref:** 1.3  
**Files:** `backend/main.py`, `docker-compose.yml`  
**Why:** All endpoints — including write operations (scan trigger, credential create/delete, config import, image upload) — are fully open with no authentication. Any script on the LAN can modify or destroy the database.

**What to change:**

1. Add a `SECRET_TOKEN` environment variable to the backend.
2. Implement a FastAPI dependency that validates the token via the `Authorization: Bearer <token>` header:

```python
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi import Security, HTTPException, status

SECRET_TOKEN = os.getenv("SECRET_TOKEN", "")
_bearer = HTTPBearer(auto_error=False)

def require_auth(credentials: HTTPAuthorizationCredentials = Security(_bearer)):
    if not SECRET_TOKEN:
        return  # auth disabled — warn at startup
    if not credentials or credentials.credentials != SECRET_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
```

3. Add `dependencies=[Depends(require_auth)]` to every router or the `app` itself:

```python
app = FastAPI(dependencies=[Depends(require_auth)])
```

4. Update `docker-compose.yml` to inject `SECRET_TOKEN` from a `.env` file.
5. Update `frontend/src/api.js` to read the token from `import.meta.env.VITE_API_TOKEN` and inject it as the `Authorization` header on every request.
6. Add `SECRET_TOKEN=` to a `.env.example` file and document the requirement in `README.md`.

> **Note:** If users want a login UI in future, this bearer token approach can be replaced with a proper auth solution (JWT, OAuth) without changing client/server contracts.

---

## Priority 2 — HIGH (Fix Before Next Release)

---

### H-1 · Eliminate SQL injection-prone f-string `text()` calls
**Ref:** 1.4  
**File:** `backend/database.py`  
**Why:** f-string interpolation into `text()` is a latent injection risk. The current values are constants, but the pattern will be silently unsafe if user data is ever passed here.

**What to change:**  
Replace every `text(f"...")` call with a parameterised form:

```python
# Before
conn.execute(text(f"INSERT OR IGNORE INTO app_settings (key, value) VALUES ('{key}', '{value}')"))

# After
conn.execute(
    text("INSERT OR IGNORE INTO app_settings (key, value) VALUES (:key, :value)"),
    {"key": key, "value": value}
)
```

For DDL statements where parameterisation is not supported (e.g. `ALTER TABLE ... ADD COLUMN`), validate `col_name` and `col_def` against a whitelist of known safe identifiers before interpolation, and add a comment explaining why the f-string is safe here.

---

### H-2 · Replace hardcoded seed passwords with clearly fictional values
**Ref:** 1.6  
**File:** `backend/seed_db.py` lines 205-225  
**Why:** Real-looking passwords such as `Auth@FS_Global#2026` could be confused for actual credentials and accidentally loaded into a production database.

**What to change:**
- Replace all `v3_auth_password` and `v3_priv_password` values with `"CHANGEME_auth"` and `"CHANGEME_priv"`.
- Replace the procedurally generated per-device passwords (`Auth@RACK-A00#2026`) with a similar `"CHANGEME_auth_{device_id}"` pattern.
- Add a top-of-file comment: `# DEVELOPMENT SEED DATA ONLY — do not run against production`.

---

### H-3 · Fix background scheduler: use a new DB session per scan
**Ref:** 3.1  
**File:** `backend/main.py` — `_background_scheduler` function  
**Why:** SQLAlchemy sessions are not designed to be shared across multiple `asyncio` event loops. Passing the same session from loop to loop can cause stale state, lock contention, or silent data corruption.

**What to change:**
- Remove the single `db = SessionLocal()` created outside the loops.
- Inside each `loop.run_until_complete(...)` block, create and close a fresh session:

```python
def _run_scan(scan_type: str):
    db = SessionLocal()
    try:
        loop = asyncio.new_event_loop()
        loop.run_until_complete(_execute_scan(db, scan_type=scan_type))
    finally:
        db.close()
        loop.close()

_run_scan("discovery")
_run_scan("links")
_run_scan("metrics")
```

---

### H-4 · Add a database migration framework (Alembic)
**Ref:** 3.2  
**Files:** `backend/database.py`, new `backend/alembic/` directory  
**Why:** The ad-hoc `_ensure_*` + raw `ALTER TABLE` approach has no version tracking, no rollback, and will be incompatible with any future move to PostgreSQL.

**What to change:**
1. Add `alembic` to `backend/requirements.txt`.
2. Run `alembic init backend/alembic` to create the migration scaffold.
3. Write an initial migration (`alembic revision --autogenerate -m "initial_schema"`) that captures the current schema.
4. Replace the body of `_ensure_*` functions with a call to `alembic upgrade head` at startup.
5. Retain the current `_ensure_*` functions as a one-time migration shim that runs only once then records its execution in a `schema_migrations` table.

---

### H-5 · Fix API client to throw on HTTP errors
**Ref:** 5.1  
**File:** `frontend/src/api.js`  
**Why:** All methods silently return error JSON (e.g. `{ detail: "..." }`) as if it were successful data. Callers have no way to distinguish a 500 error from a valid empty response.

**What to change:**  
Add an `r.ok` check before calling `.json()` in every method:

```javascript
// api.js
async function checkOk(r) {
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`HTTP ${r.status}: ${text}`);
  }
  return r;
}

const api = {
  get: async (path) => {
    // ... existing ETag logic ...
    const r = await fetch(BASE + path, { headers });
    if (r.status === 304) return _etagCache[path].data;
    await checkOk(r);
    // ... rest of ETag handling ...
  },
  post:  async (path, body) => checkOk(await fetch(...)).then(r => r.json()),
  put:   async (path, body) => checkOk(await fetch(...)).then(r => r.json()),
  patch: async (path, body) => checkOk(await fetch(...)).then(r => r.json()),
  del:   async (path)       => checkOk(await fetch(...)),
};
```

Update all call sites that currently ignore errors to wrap in `try/catch` and display an error state to the user.

---

### H-6 · Fix scheduler to survive exceptions in `_execute_scan`
**Ref:** 5.2  
**File:** `backend/main.py` — `_background_scheduler`  
**Why:** An uncaught exception in `_execute_scan` silently stops all future scheduled scans because `last_discovery` (or equivalent timer variable) is never updated.

**What to change:**
- After each `_run_scan(...)` call, always update the `last_*` timestamp in a `finally` block regardless of whether `_execute_scan` succeeded:

```python
try:
    _run_scan("discovery")
except Exception as e:
    _log_event(logging.ERROR, "scheduler.discovery_failed", error=str(e))
finally:
    last_discovery = time.time()   # reset timer even on failure to avoid tight retry loop
```

- Add a monotonically increasing failure counter and back off exponentially if the same scan type fails repeatedly.

---

### H-7 · Add N+1 query protection to topology endpoint
**Ref:** 4.1  
**File:** `backend/main.py` — `GET /api/topology` endpoint, `backend/database.py` — relationship definitions  
**Why:** With lazy loading, each device in the topology response issues a separate `SELECT` for its ports, rack, class, and model — resulting in 25+ extra queries per page load with the seed data.

**What to change:**

Option A (preferred — change relationship defaults):
```python
# database.py
class Device(Base):
    ports = relationship("Port", back_populates="device", lazy="selectin")
    rack  = relationship("Rack", lazy="joined")
    switch_class = relationship("SwitchClass", lazy="joined")
    switch_model = relationship("SwitchModel", lazy="joined")
```

Option B (targeted — change endpoint query):
```python
from sqlalchemy.orm import selectinload, joinedload

devices = (
    db.query(Device)
    .options(
        selectinload(Device.ports),
        joinedload(Device.rack),
        joinedload(Device.switch_class),
        joinedload(Device.switch_model),
    )
    .all()
)
```

Option B is safer if other endpoints benefit from lazy loading.

---

### H-8 · Run backend container as non-root user
**Ref:** 8.1  
**File:** `backend/Dockerfile`  
**Why:** uvicorn runs as root inside the container. A code-execution vulnerability would give the attacker full container root, which may map to root on the host if volumes are misconfigured.

**What to change:**  
Add near the end of the Dockerfile, before the `CMD`:

```dockerfile
RUN adduser --disabled-password --gecos "" appuser \
    && mkdir -p /data \
    && chown -R appuser:appuser /app /data
USER appuser
```

Verify that `/data` is writable by `appuser` when the Docker volume is mounted.

---

### H-9 · Make `POST /api/scan` asynchronous
**Ref:** 9.1  
**File:** `backend/main.py`  
**Why:** The scan endpoint blocks the HTTP request for the full scan duration (potentially 30–120 seconds for large networks). This can cause client-side timeouts and makes progress reporting impossible.

**What to change:**
1. Add a `scan_jobs` dict (or a `ScanJob` table) to track running jobs: `{ job_id: { "status": "running", "started_at": ..., "result": None } }`.
2. Change `POST /api/scan` to:
   - Create a job record and return `{ "job_id": "<uuid>", "status": "running" }` with HTTP 202 Accepted.
   - Launch `_execute_scan` in a background thread or async task.
3. Add `GET /api/scan-jobs/{job_id}` to poll job status.
4. Update the frontend `SettingsPage.jsx` / scan UI to poll the job status endpoint until completion.

---

### H-10 · Add React error boundaries
**Ref:** 7.1  
**Files:** `frontend/src/App.jsx`, all page components  
**Why:** Any unhandled JavaScript error in a page component crashes the entire app and shows a blank screen with no recovery path.

**What to change:**
1. Create `frontend/src/components/ErrorBoundary.jsx`:

```jsx
import React from "react";
export class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error("ErrorBoundary caught:", e, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: "red" }}>
          <h2>Something went wrong.</h2>
          <pre>{this.state.error.message}</pre>
          <button onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

2. Wrap the `<Routes>` block in `App.jsx` with `<ErrorBoundary>`, and wrap each page import individually for finer granularity.

---

### H-11 · Validate localStorage zoom value shape in MapPage
**Ref:** 7.2  
**File:** `frontend/src/pages/MapPage.jsx`  
**Why:** If the stored zoom value has the wrong shape (e.g. `{"scale": "abc"}`), NaN propagates silently into SVG transforms.

**What to change:**

```javascript
function isValidZoom(z) {
  return (
    z && typeof z === "object" &&
    typeof z.scale === "number" && isFinite(z.scale) &&
    typeof z.tx === "number" && isFinite(z.tx) &&
    typeof z.ty === "number" && isFinite(z.ty)
  );
}

const [zoom, setZoom] = useState(() => {
  try {
    const s = localStorage.getItem("netmap-zoom");
    if (s) {
      const parsed = JSON.parse(s);
      if (isValidZoom(parsed)) return parsed;
    }
  } catch {}
  return { scale: 1, tx: 0, ty: 0 };
});
```

---

### H-12 · Extract monolithic `main.py` into routers/services
**Ref:** 2.1  
**File:** `backend/main.py` (2066 lines)  
**Why:** A 2066-line single file is unmaintainable and untestable. Route handlers for 8+ resource types are all co-located.

**What to change:**  
Create the following structure and migrate routes incrementally:

```
backend/
  routers/
    __init__.py
    credentials.py      # /api/credentials, /api/snmp-profiles
    devices.py          # /api/devices, /api/topology
    scan.py             # /api/scan, /api/scan-runs
    racks.py            # /api/racks, /api/switch-classes, /api/switch-models
    settings.py         # /api/settings, /api/map-bg
    config.py           # /api/config/export, /api/config/import
    bulk.py             # /api/bulk-export, /api/bulk-import
    logs.py             # /api/logs
  services/
    __init__.py
    scan_service.py     # _execute_scan, _background_scheduler
    scheduler.py        # scheduler thread management
  main.py               # app instantiation + include_router() calls only
```

Migration strategy: move one router at a time, run tests after each move to verify no regressions.

---

### H-13 · Split `SettingsPage.jsx` into per-tab components
**Ref:** 2.2  
**File:** `frontend/src/pages/SettingsPage.jsx` (2071 lines)  
**Why:** A 2071-line single component is unmaintainable. Each settings tab is logically independent.

**What to change:**  
Extract each tab into its own file:

```
frontend/src/components/settings/
  CredentialsTab.jsx
  SnmpProfilesTab.jsx
  RacksTab.jsx
  SwitchClassesTab.jsx
  SwitchModelsTab.jsx
  ScanSettingsTab.jsx
  DnsTab.jsx
  MapSettingsTab.jsx
  ImportExportTab.jsx
```

`SettingsPage.jsx` becomes a thin shell that renders the tab navigation and lazy-imports the active tab component.

---

### H-14 · Split `MapPage.jsx` into sub-components
**Ref:** 2.3  
**File:** `frontend/src/pages/MapPage.jsx` (1108 lines)  
**Why:** Topology SVG, rack list panel, filter bar, and interaction logic are all in a single file.

**What to change:**

```
frontend/src/components/map/
  TopologyMap.jsx       # SVG rendering + drag/zoom logic
  RackPanel.jsx         # rack list sidebar
  FilterBar.jsx         # filter controls
  ActiveLinkBar.jsx     # active link details strip
```

`MapPage.jsx` becomes the orchestrator that manages shared state and passes props to these components.

---

### H-15 · Fix `Promise.all` in settings tabs to handle partial failures
**Ref:** 5.5  
**File:** `frontend/src/pages/SettingsPage.jsx` (and tab components after H-13)  
**Why:** A single API failure in a `Promise.all` discards all results and leaves the UI in an indefinite loading state.

**What to change:**  
Replace `Promise.all([...]).catch(() => setLoading(false))` with `Promise.allSettled`:

```javascript
const [credsRes, topoRes, racksRes, classesRes] = await Promise.allSettled([
  api.get("/api/credentials"),
  api.get("/api/topology"),
  api.get("/api/racks"),
  api.get("/api/switch-classes"),
]);
setCreds(credsRes.status === "fulfilled" ? credsRes.value : []);
// ... repeat for each result
setLoading(false);
if ([credsRes, topoRes, racksRes, classesRes].some(r => r.status === "rejected")) {
  setError("Some data failed to load. Displaying partial results.");
}
```

---

### H-16 · Add `GET /api/stats` endpoint and use it in DashboardPage
**Ref:** 4.2  
**Files:** `backend/main.py`, `frontend/src/pages/DashboardPage.jsx`  
**Why:** The dashboard currently loads the full topology (including all port data for all devices) just to compute summary counts — wasteful for large networks.

**What to change:**
1. Add `GET /api/stats` to the backend that returns only aggregate counts:

```python
@app.get("/api/stats")
def get_stats(db: Session = Depends(get_db)):
    return {
        "device_count": db.query(Device).count(),
        "port_count": db.query(Port).count(),
        "port_up_count": db.query(Port).filter(Port.oper_status == "up").count(),
        "rack_count": db.query(Rack).count(),
        "last_scan": ...,
    }
```

2. Update `DashboardPage.jsx` to call `GET /api/stats` instead of `GET /api/topology`.

---

## Priority 3 — MEDIUM (Address in Upcoming Sprint)

---

### M-1 · Warn user when SNMP community string is "public"
**Ref:** 1.7  
**Files:** `frontend/src/pages/SettingsPage.jsx` (or `CredentialsTab.jsx` after H-13)  
**Why:** The insecure default `"public"` community string is silently accepted. The UI should warn the operator.

**What to change:**  
Add a validation warning below the community field:
```jsx
{community === "public" && (
  <span style={{ color: "orange" }}>
    Warning: "public" is the factory-default community string and may allow unauthorised SNMP access.
  </span>
)}
```

---

### M-2 · Document HTTPS limitation in README
**Ref:** 1.8  
**File:** `README.md`  
**Why:** All traffic (including credentials entered in the browser) is transmitted in cleartext over HTTP.

**What to change:**  
Add a "Known Limitations" or "Security Notes" section to `README.md`:
```
- No HTTPS: All traffic is unencrypted. Do not use this tool on untrusted networks.
  To enable HTTPS, configure a reverse proxy (e.g. Traefik, Caddy) in front of the nginx container.
```

---

### M-3 · Validate uploaded file MIME type in map-bg endpoint
**Ref:** 1.9  
**File:** `backend/main.py` — `POST /api/map-bg`  
**Why:** The backend performs no content-type or magic-byte check on uploaded background images — arbitrary binary content can be uploaded.

**What to change:**
```python
import imghdr

ALLOWED_TYPES = {"png", "jpeg", "gif", "webp"}

@app.post("/api/map-bg")
async def upload_map_bg(file: UploadFile = File(...)):
    content = await file.read()
    detected = imghdr.what(None, h=content)
    if detected not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported image type: {detected}")
    # proceed with save
```

---

### M-4 · Fix cross-platform ping command
**Ref:** 1.10  
**File:** `backend/main.py` — `_ping_host_async`  
**Why:** Linux-only `-c`/`-W` flags cause silent failure on bare-metal Windows development.

**What to change:**
```python
import platform

def _build_ping_cmd(ip: str, timeout_sec: int) -> list[str]:
    if platform.system() == "Windows":
        return ["ping", "-n", "1", "-w", str(timeout_sec * 1000), ip]
    return ["ping", "-c", "1", "-W", str(timeout_sec), ip]
```

---

### M-5 · Rename ORM model to avoid `SwitchModelModel` aliasing
**Ref:** 2.4  
**Files:** `backend/database.py`, `backend/main.py`  
**Why:** `from database import SwitchModel as SwitchModelModel` is a naming antipattern caused by a naming collision between the SQLAlchemy model and Pydantic schema.

**What to change:**
- Rename the SQLAlchemy class `SwitchModel` in `database.py` to `SwitchModelOrm`.
- Update all references in `main.py` (remove the `as SwitchModelModel` alias, use `SwitchModelOrm` directly).

---

### M-6 · Remove dead placeholder code in SettingsPage
**Ref:** 2.5  
**File:** `frontend/src/pages/SettingsPage.jsx` lines 300-330  
**Why:** A ghost placeholder element showing dummy data ("Core Switch RZ-01", "192.168.1.1") adds dead DOM nodes and is confusing.

**What to change:**  
Delete the dummy static card block entirely. Confirm the floating edit form renders correctly without it.

---

### M-7 · Extract shared style constants
**Ref:** 2.6  
**Files:** `frontend/src/components/settings/*.jsx` (after H-13), potentially a new `frontend/src/styles/shared.js`  
**Why:** `inp`, `sel`, `btnStyle` etc. are redefined identically in every component.

**What to change:**  
Create `frontend/src/styles/shared.js` that exports common style objects:
```javascript
export const inp = { background: "#1e2a3a", border: "1px solid #334", color: "#e0e8f0", ... };
export const sel = { ...inp };
export const btn = { ... };
export const btnDanger = { ...btn, background: "#a33" };
```
Import and use these in all components.

---

### M-8 · Move `import re` to module level in main.py
**Ref:** 2.7  
**File:** `backend/main.py`  
**Why:** `import re as _re` inside a hot async function is an antipattern.

**What to change:**  
Add `import re` at the top of `main.py` and remove the nested import from `_ping_host_async`.

---

### M-9 · Document speedLabel maintenance risk
**Ref:** 2.8  
**Files:** `backend/snmp_scanner.py`, `frontend/src/api.js`  
**Why:** The `speedLabel` function is duplicated in Python and JavaScript; a change to one must be manually mirrored.

**What to change:**  
Add a comment above each implementation:
```python
# NOTE: This logic is mirrored in frontend/src/api.js speedLabel().
# Any changes here must be reflected there too.
```
Consider creating a shared test that validates both implementations return identical results for the same inputs.

---

### M-10 · Fix Credential / SnmpProfile bidirectional sync duplication
**Ref:** 3.3  
**File:** `backend/main.py` — `update_snmp_profile`  
**Why:** When a profile is updated, all linked credentials are explicitly updated with a copy of every SNMP field. This bidirectional sync is fragile and redundant because the scan code already reads from the profile when `profile_id` is set.

**What to change:**  
Remove the batch update of linked credentials in `update_snmp_profile`. Verify that `_execute_scan` reads `profile.snmp_version` (not `cred.snmp_version`) when `cred.profile_id` is set — this is already the case per the analysis. Add a comment explaining the design: per-credential fields are only used when `profile_id` is `None`.

---

### M-11 · Move `auto_layout` out of snmp_scanner.py
**Ref:** 3.4  
**Files:** `backend/snmp_scanner.py`, `backend/main.py` (or a new `backend/layout.py`)  
**Why:** `auto_layout` is a positioning/layout function with no SNMP dependency. Its presence in the SNMP I/O module violates separation of concerns.

**What to change:**  
Move `auto_layout` to `backend/layout.py` (create new file). Update the import in `main.py` to `from layout import auto_layout`.

---

### M-12 · Document single-worker constraint for LOG_BUFFER
**Ref:** 3.5  
**File:** `backend/main.py`, `backend/Dockerfile`  
**Why:** If the number of uvicorn workers is ever increased, each process would have its own `LOG_BUFFER`, silently fragmenting logs.

**What to change:**  
Add a comment in `main.py` near `LOG_BUFFER`:
```python
# LOG_BUFFER is an in-process buffer. The app must be run with --workers 1
# (as set in the Dockerfile CMD) for this to be correct.
# If multiple workers are needed, move the log buffer to the database.
```
Also add a comment in the `Dockerfile` CMD:
```dockerfile
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
# NOTE: workers=1 is required because log buffer is in-process memory.
```

---

### M-13 · Fix logs polling to respect page visibility
**Ref:** 4.3  
**File:** `frontend/src/pages/LogsPage.jsx`  
**Why:** The 5-second poll interval continues even when the browser tab is not visible, generating unnecessary API traffic.

**What to change:**
```javascript
useEffect(() => {
  if (!autoRefresh) return;
  const t = setInterval(() => {
    if (document.visibilityState === "visible") loadLogs();
  }, 5000);
  return () => clearInterval(t);
}, [autoRefresh, loadLogs]);
```

---

### M-14 · Cap or exclude the ETag cache for dynamic log queries
**Ref:** 6.2  
**File:** `frontend/src/api.js`  
**Why:** Each unique filter combination creates a new cache entry in `_etagCache`. With frequently changing filters, the cache grows without bound.

**What to change:**  
Option A: exclude `/api/logs` from ETag caching (use plain `fetch`).  
Option B: limit `_etagCache` to a maximum of N entries (LRU eviction):
```javascript
const MAX_CACHE = 100;
// after writing a new entry:
const keys = Object.keys(_etagCache);
if (keys.length > MAX_CACHE) delete _etagCache[keys[0]];
```

---

### M-15 · Standardise HTTP methods for device update endpoints
**Ref:** 6.3  
**File:** `backend/main.py`  
**Why:** `PUT /api/devices/{id}/meta` uses `PUT` for a partial update, which is incorrect REST semantics.

**What to change:**  
Change `PUT /api/devices/{id}/meta` to `PATCH /api/devices/{id}/meta`. Update the corresponding call in the frontend.

---

### M-16 · Replace `window.confirm` with inline confirmation state
**Ref:** 7.3  
**File:** `frontend/src/pages/SettingsPage.jsx` (or tab components after H-13)  
**Why:** `window.confirm` is synchronous, blocks the UI thread, and is suppressed in some browser environments.

**What to change:**  
For each destructive action (delete credential, delete profile), replace:
```javascript
if (confirm("Delete?")) { api.del(...) }
```

with a React state-driven confirmation flow:
```jsx
const [confirmDelete, setConfirmDelete] = useState(null); // holds id to delete
// ...
{confirmDelete === item.id && (
  <span>
    Are you sure?
    <button onClick={() => { api.del(...); setConfirmDelete(null); }}>Yes, delete</button>
    <button onClick={() => setConfirmDelete(null)}>Cancel</button>
  </span>
)}
```

---

### M-17 · Add loading and error states to MapPage
**Ref:** 7.4  
**File:** `frontend/src/pages/MapPage.jsx`  
**Why:** If the topology API call fails, the map renders empty with no user-visible error.

**What to change:**
```javascript
const [topo, setTopo] = useState(null);
const [error, setError] = useState(null);

useEffect(() => {
  api.get("/api/topology")
    .then(setTopo)
    .catch(e => setError(e.message));
}, []);

if (error) return <div style={{ color: "red", padding: 32 }}>Failed to load topology: {error}</div>;
if (!topo) return <div style={{ padding: 32 }}>Loading...</div>;
```

---

### M-18 · Fix accessibility issues in interactive elements
**Ref:** 7.5  
**Files:** `frontend/src/pages/MapPage.jsx`, `frontend/src/pages/SettingsPage.jsx`, `frontend/src/components/`  
**Why:** Interactive `<div>` and `<span>` elements with `onClick` are inaccessible to keyboard and screen reader users.

**What to change:**
- Add `role="button"`, `tabIndex={0}`, and `onKeyDown={e => e.key === "Enter" && handler()}` to all interactive `<div>` elements.
- Replace `"X"` and `"<->"` icon labels with `aria-label` attributes or `<span aria-hidden="true">` + visually hidden text.
- Replace `<div>` label containers with `<label>` elements where wrapping `<input>`.

---

### M-19 · Move Google Fonts import to index.html
**Ref:** 7.6  
**Files:** `frontend/src/App.jsx`, `frontend/index.html`  
**Why:** `@import` inside a `<style>` tag is the slowest loading mechanism for external CSS.

**What to change:**  
Remove the `@import url('https://fonts.googleapis.com/...')` from the `<style>` tag in `App.jsx`.  
Add to `frontend/index.html` `<head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
```

Also move the global CSS reset (`*, *::before, *::after { box-sizing: ... }`) from the inline `<style>` in `App.jsx` to a `frontend/src/index.css` file imported once in `main.jsx`.

---

### M-20 · Use `npm ci` in frontend Dockerfile
**Ref:** 8.2  
**File:** `frontend/Dockerfile`  
**Why:** `npm install` is non-reproducible without a committed lockfile.

**What to change:**
- Generate and commit `frontend/package-lock.json` (run `npm install` locally once).
- Replace `RUN npm install` with `RUN npm ci` in the Dockerfile.

---

### M-21 · Add health checks to docker-compose.yml
**Ref:** 8.3  
**File:** `docker-compose.yml`  
**Why:** The frontend nginx may proxy requests before the backend has finished its startup migrations.

**What to change:**
1. Add `GET /health` to `backend/main.py`:
```python
@app.get("/health")
def health(): return {"status": "ok"}
```

2. Update `docker-compose.yml`:
```yaml
backend:
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
    interval: 10s
    timeout: 5s
    retries: 5
frontend:
  depends_on:
    backend:
      condition: service_healthy
```

---

### M-22 · Protect SQLite database file permissions
**Ref:** 8.4  
**File:** `backend/Dockerfile`  
**Why:** The database file is world-readable within the container when running as root.

**What to change:**  
This is resolved by H-8 (running as non-root). Additionally, after H-8 is applied, add:
```dockerfile
RUN chmod 700 /data
```
to ensure only `appuser` can access the `/data` directory.

---

### M-23 · Remove `snmp_scanner.py.bak` from the repository
**Ref:** 9.3  
**File:** `backend/snmp_scanner.py.bak`  
**Why:** Backup files should not be tracked in version control. This also gets copied into the Docker image.

**What to change:**
```bash
git rm backend/snmp_scanner.py.bak
echo "*.bak" >> .gitignore
```

---

### M-24 · Remove `bundle_debug.js` from the repository
**Ref:** 9.4  
**File:** `bundle_debug.js` (workspace root)  
**Why:** Build artifact accidentally committed.

**What to change:**
```bash
git rm bundle_debug.js
echo "bundle_debug.js" >> .gitignore
```

---

### M-25 · Document or remove `fix_encoding.py`
**Ref:** 9.5  
**File:** `fix_encoding.py` (workspace root)  
**Why:** Undocumented utility script with unclear purpose.

**What to change:**  
Determine whether the script is still needed:
- If yes: add a docstring, move to `scripts/fix_encoding.py`, and add an entry in `README.md`.
- If no: `git rm fix_encoding.py`.

---

### M-26 · Remove `todo.md` from version control
**Ref:** 9.6  
**File:** `todo.md`  
**Why:** Development task tracking should not be a tracked file. It creates noise in the commit log.

**What to change:**
```bash
git rm todo.md
echo "todo.md" >> .gitignore
```
Migrate the to-do items to the project issue tracker.

---

### M-27 · Audit and update `pyasn1` pin
**Ref:** 10.2  
**File:** `backend/requirements.txt`  
**Why:** `pyasn1==0.4.8` (2019) is very old and may have CVEs.

**What to change:**
- Run `pip install pyasn1 --upgrade` in a test environment and verify `pysnmp-lextudio` still works.
- If compatible, update the pin in `requirements.txt` to the latest stable version.
- If not compatible due to a transitive constraint, add a comment: `# pinned to N.N.N — pysnmp-lextudio requires this version; see issue #XXX`.

---

### M-28 · Document `pysnmp-lextudio` dependency rationale
**Ref:** 10.1  
**File:** `backend/requirements.txt`  
**Why:** The fork choice should be documented so future maintainers understand why the non-standard package is used.

**What to change:**  
Add a comment in `requirements.txt`:
```
# pysnmp-lextudio: maintained community fork of the abandoned pysnmp library.
# Original pysnmp (<=4.4.12) is unmaintained. Monitor https://github.com/lextudio/pysnmp for updates.
pysnmp-lextudio==5.0.34
```

---

### M-29 · Add `POST /api/scan` job ID to response and poll pattern  
*(Additional detail for H-9 — medium sub-tasks)*  
**Ref:** 6.1  
**File:** `backend/main.py`  
**Why:** `POST /api/scan` should return the created `ScanRun` resource (with `id`) so clients can poll status. Currently it returns a generic `ScanResult` with no stable identifier.

**What to change:**  
Covered in H-9. Add `GET /api/scan-runs/{id}` endpoint that returns job status.

---

### M-30 · Fix SNMP error logging levels
**Ref:** 5.3  
**File:** `backend/snmp_scanner.py`  
**Why:** Authentication failures and transport errors are logged at DEBUG, making them invisible in production.

**What to change:**
```python
except AuthenticationError as exc:
    log.warning("snmp_get %s: authentication failed: %s", ip, exc)
except ConnectionRefusedError as exc:
    log.warning("snmp_get %s: connection refused: %s", ip, exc)
except Exception as exc:
    log.debug("snmp_get %s: unexpected error: %s", ip, exc)
```

---

### M-31 · Log parse errors in Port.jsx
**Ref:** 5.6 (escalated from LOW to MEDIUM for diagnostic value)  
**File:** `frontend/src/components/Port.jsx`  
**Why:** Silent JSON parse failures mask malformed backend data.

**What to change:**
```javascript
} catch (e) {
  console.warn("Port: failed to parse JSON value", raw, e);
  return [];
}
```

---

### M-32 · Rename `format` parameter to `fmt` in bulk_export
**Ref:** 6.4  
**File:** `backend/main.py`  
**Why:** The `format` parameter name shadows Python's built-in `format()`.

**What to change:**
```python
# Before
def bulk_export(kind: str, format: str = "json", ...):

# After
def bulk_export(kind: str, fmt: str = "json", ...):
```
Update all internal references from `format` to `fmt` within that function.

---

### M-33 · Audit DELETE endpoints for consistent 404 handling
**Ref:** 6.5  
**File:** `backend/main.py`  
**Why:** Inconsistent 404/204 behaviour across delete handlers.

**What to change:**  
Add a checklist review of all `DELETE` handlers:
- `delete_credential` — returns 404 if missing: correct.
- `delete_rack`, `delete_switch_class`, `delete_switch_model` — verify all return 404 if missing.
- Ensure no handler returns 204 for a resource that did not exist.

---

## Priority 4 — LOW (Address When Convenient)

---

### L-1 · Fix `SHA-256` pysnmp constant comment
**Ref:** 2.9  
**File:** `backend/snmp_scanner.py`  
**Why:** `usmHMAC192SHA256AuthProtocol` is counterintuitive. The "192" refers to HMAC key size, not the hash.

**What to change:**  
Add a comment:
```python
"SHA-256": usmHMAC192SHA256AuthProtocol,  # pysnmp constant name includes "192" (HMAC key size), not the hash size
```

---

### L-2 · Fix `ScanResult.status` default
**Ref:** 2.10  
**File:** `backend/schemas.py`  
**Why:** Defaulting `status` to `"finished"` is misleading when a scan is cancelled.

**What to change:**
```python
class ScanResult(BaseModel):
    status: str = "unknown"   # not "finished" — set explicitly at runtime
```

---

### L-3 · Convert `_expand_ranges_to_ips` to use a generator
**Ref:** 4.5  
**File:** `backend/main.py`  
**Why:** The function materialises up to 65,536 strings in memory before scanning begins.

**What to change:**  
Wherever the result of `_expand_ranges_to_ips` is consumed in a loop, pass a generator instead:
```python
def _expand_ranges_to_ips(ranges: list[str]):
    for r in ranges:
        net = ipaddress.ip_network(r, strict=False)
        if net.num_addresses > 65536:
            raise ValueError(...)
        yield from (str(h) for h in net.hosts())
```
Verify all call sites are compatible with a generator (not indexing or slicing the result).

---

### L-4 · Create `.dockerignore` for the backend
**Ref:** 8.6  
**File:** `backend/.dockerignore` (new file)  
**Why:** `COPY . .` copies development files (`seed_db.py`, `*.bak`, `requirements.txt`) into the image.

**What to change:**  
Create `backend/.dockerignore`:
```
__pycache__/
*.pyc
*.bak
.env
seed_db.py
```

---

### L-5 · Document `VITE_API_URL` bake-in behaviour
**Ref:** 9.7  
**Files:** `README.md`, `frontend/vite.config.js`  
**Why:** Users cannot change the backend URL after building the image without knowing it is baked in.

**What to change:**  
Add a note to `README.md`:
```
## Configuration

`VITE_API_URL` is baked into the frontend bundle at build time. To point the frontend at a
different backend, rebuild the image with `--build-arg VITE_API_URL=http://your-backend:8000`.
```

---

### L-6 · Update page title in index.html
**Ref:** 9.8  
**File:** `frontend/index.html`  
**Why:** "Aruba CX Topology" implies a single-vendor tool; the app supports multiple vendors.

**What to change:**
```html
<!-- Before -->
<title>NetMap - Aruba CX Topology</title>
<!-- After -->
<title>NetMap</title>
```

---

### L-7 · Remove font-size override hack from App.jsx
**Ref:** 7.7  
**Files:** `frontend/src/App.jsx`, `frontend/src/components/Port.jsx`  
**Why:** The `[style*="font-size: 8px"]` global override masks the real problem (sub-12px inline styles in Port.jsx).

**What to change:**
- In `Port.jsx`, change `fontSize: 8` and `fontSize: 10` to `fontSize: 12`.
- Remove the `[style*="font-size:..."] { font-size: 12px !important; }` block from `App.jsx`.

---

### L-8 · Replace `key={idx}` with stable keys in LogsPage
**Ref:** 7.8  
**File:** `frontend/src/pages/LogsPage.jsx`  
**Why:** Array index as React key causes unnecessary reconciliation on insert/remove.

**What to change:**
```jsx
// Before
rows.map((entry, idx) => <div key={idx} ...>

// After
rows.map((entry, idx) => <div key={`${entry.ts}-${idx}`} ...>
```

---

### L-9 · Add Dockerfile comment for iputils-ping Linux dependency
**Ref:** 8.5  
**File:** `backend/Dockerfile`  
**Why:** The ping dependency is non-obvious and fails silently on Windows.

**What to change:**
```dockerfile
# iputils-ping provides the Linux ping binary required by _ping_host_async().
# The ping flags used (-c, -W) are Linux-specific. Do not remove this package.
RUN apt-get install -y iputils-ping
```

---

### L-10 · Generate and commit `package-lock.json`
**Ref:** 10.3  
**File:** `frontend/package-lock.json`  
**Why:** Without a lockfile, `npm install` and `npm ci` are non-reproducible.

**What to change:**
```bash
cd frontend
npm install   # generates package-lock.json
git add package-lock.json
git commit -m "chore: add package-lock.json for reproducible builds"
```

---

### L-11 · Note on `react-router-dom` caret range
**Ref:** 10.4  
**File:** `frontend/package.json`  
**Why:** Caret ranges without a lockfile can silently break builds on patch updates.

**What to change:**  
This is resolved by L-10 (committing the lockfile). No code change required once the lockfile is committed.

---

## Implementation Checklist

Copy this checklist into the tracking issue and check off each item as it is completed.

### CRITICAL
- [x] C-1 — Fix CORS `allow_origins` (use env var, not wildcard)
- [x] C-2 — Mask SNMP passwords in `CredentialOut` / `SnmpProfileOut`
- [x] C-3 — Add bearer token authentication to all endpoints

### HIGH
- [x] H-1 — Parameterise all `text(f"...")` SQL calls
- [x] H-2 — Replace seed passwords with `CHANGEME_*` values
- [x] H-3 — New DB session per scan in `_background_scheduler`
- [x] H-4 — Introduce Alembic for schema migrations  (DONE — v1.2.0)
- [x] H-5 — Throw on HTTP errors in `api.js`
- [x] H-6 — Scheduler: always update timer in `finally`, add backoff
- [x] H-7 — Eager-load relations in topology endpoint
- [x] H-8 — Run backend as non-root user in Dockerfile
- [x] H-9 — Make `POST /api/scan` asynchronous (return job ID)  (DONE — was already implemented)
- [x] H-10 — Add `ErrorBoundary` component and wrap all pages
- [x] H-11 — Validate localStorage zoom shape in MapPage
- [ ] H-12 — Split `main.py` into routers/services  (NOT done — pending)
- [x] H-13 — Split `SettingsPage.jsx` into per-tab components  (DONE — v1.2.0)
- [x] H-14 — Split `MapPage.jsx` into sub-components  (DONE — v1.2.0)
- [x] H-15 — Use `Promise.allSettled` for multi-API loads
- [x] H-16 — Add `GET /api/stats` and use in DashboardPage

### MEDIUM
- [x] M-1 — Warn on "public" community string in UI
- [x] M-2 — Document HTTPS limitation in README
- [x] M-3 — Validate file MIME type in map-bg upload
- [x] M-4 — Cross-platform ping command
- [ ] M-5 — Rename `SwitchModel` ORM to `SwitchModelOrm`  (NOT done)
- [ ] M-6 — Remove dead placeholder code in SettingsPage  (NOT done)
- [ ] M-7 — Extract shared style constants  (NOT done)
- [x] M-8 — Move `import re` to module level
- [x] M-9 — Document `speedLabel` duplication
- [x] M-10 — Remove redundant credential sync on profile update
- [ ] M-11 — Move `auto_layout` to `layout.py`  (NOT done)
- [x] M-12 — Document single-worker constraint for LOG_BUFFER
- [x] M-13 — Page Visibility API for logs polling
- [x] M-14 — Cap or exclude ETag cache for logs
- [x] M-15 — Change `PUT /meta` to `PATCH /meta`
- [x] M-16 — Replace `window.confirm` with inline confirmation
- [x] M-17 — Add loading/error state to MapPage
- [ ] M-18 — Fix accessibility on interactive elements  (NOT done)
- [x] M-19 — Move Google Fonts to `<link>` in index.html
- [ ] M-20 — Use `npm ci` in frontend Dockerfile + commit lockfile  (NOT done)
- [x] M-21 — Add health checks to docker-compose.yml
- [x] M-22 — Protect `/data` directory permissions
- [x] M-23 — Remove `snmp_scanner.py.bak`  (added to .gitignore)
- [x] M-24 — Remove `bundle_debug.js`  (added to .gitignore)
- [ ] M-25 — Document or remove `fix_encoding.py`  (NOT done)
- [x] M-26 — Remove `todo.md` from version control  (added to .gitignore)
- [ ] M-27 — Audit/update `pyasn1` pin  (NOT done)
- [x] M-28 — Document `pysnmp-lextudio` fork rationale
- [ ] M-29 — Add `GET /api/scan-runs/{id}` poll endpoint  (part of H-9)
- [x] M-30 — Raise SNMP auth error log level to WARNING
- [x] M-31 — Add `console.warn` for Port.jsx JSON parse errors
- [x] M-32 — Rename `format` param to `fmt` in bulk_export
- [x] M-33 — Audit DELETE endpoints for consistent 404

### LOW
- [x] L-1 — Add comment for SHA-256 pysnmp constant
- [x] L-2 — Change `ScanResult.status` default to `"unknown"`
- [ ] L-3 — Convert `_expand_ranges_to_ips` to generator  (NOT done)
- [x] L-4 — Create `backend/.dockerignore`
- [x] L-5 — Document `VITE_API_URL` build-time bake-in
- [x] L-6 — Update page title to "NetMap"
- [x] L-7 — Remove font-size override hack; fix Port.jsx sizes
- [x] L-8 — Use stable React keys in LogsPage
- [x] L-9 — Add Dockerfile comment for iputils-ping
- [ ] L-10 — Commit `frontend/package-lock.json`  (NOT done)
- [ ] L-11 — (Resolved by L-10)

---

*This plan was generated from `docs/SubAgent/CODE_REVIEW_ANALYSIS.md` dated 2026-02-23.*
