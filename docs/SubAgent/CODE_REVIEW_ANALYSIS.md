# Code Review Analysis – NetMap

**Date:** 2026-02-23  
**Scope:** Full-stack review of all source files in `f:\Github\switch-map`  
**Reviewer:** Automated code review agent

---

## Severity Legend

| Label | Meaning |
|---|---|
| CRITICAL | Security breach, data loss, or crash possible in production |
| HIGH | Significant functional bug, security weakness, or maintainability blocker |
| MEDIUM | Suboptimal pattern that degrades quality, portability, or correctness |
| LOW | Style, documentation, or minor improvement opportunity |

---

## 1. Security

### 1.1 [CRITICAL] Wildcard CORS – `backend/main.py` line 55

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    ...
)
```

`allow_credentials=True` combined with `allow_origins=["*"]` is **explicitly rejected by browsers** (they refuse to send cookies/auth headers to wildcard origins). More importantly, if the policy were ever tightened to a real origin, this combination would allow any browser script from any origin to make authenticated requests to the API. For a LAN tool this is a low operational risk, but it violates the CORS spec and is architecturally wrong. Either drop `allow_credentials` or restrict `allow_origins` to the actual frontend origin.

### 1.2 [CRITICAL] SNMP credentials returned in cleartext by every API response – `backend/schemas.py` and `backend/main.py`

`CredentialOut` and `SnmpProfileOut` both include all v3 password fields (`v3_auth_password`, `v3_priv_password`) verbatim in their serialised JSON responses. Every call to `GET /api/credentials` or `GET /api/snmp-profiles`, and every export via `GET /api/bulk-export/credentials`, `GET /api/config/export`, returns these passwords in plaintext. There is no authentication layer on the API. Any browser tab open on the same LAN can exfiltrate all network credentials silently.

**Minimum mitigations:**
- Mask password fields in `Out` schemas (replace with `""` or `"***"`).
- Add at minimum HTTP Basic or token-based authentication to protect the API.

### 1.3 [CRITICAL] No authentication or authorisation on any endpoint

The FastAPI application has zero authentication. All endpoints – including write operations (create/delete credentials, trigger scans, import config, upload background images) – are fully open. The README acknowledges this is a LAN tool, but the Dockerised service listens on `0.0.0.0:3000` (frontend) and the backend is reachable from inside the Docker bridge network. A malicious script on any machine in the LAN can modify or destroy the database.

### 1.4 [HIGH] SQL injection via raw `text()` calls with f-string interpolation – `backend/database.py`

Several migration helpers use `text()` with Python f-strings:

```python
conn.execute(text(f"INSERT OR IGNORE INTO app_settings (key, value) VALUES ('{key}', '{value}')"))
conn.execute(text(f"ALTER TABLE devices ADD COLUMN {col_name} {col_def}"))
```

The values of `key`, `value`, `col_name`, and `col_def` come from Python constants defined in the same file (not user input), so the current risk is low. However, this pattern is inherently unsafe – a future change that passes user-controlled data here would be an unnoticed SQL injection. Replace all `text(f"...")` calls with parameterised queries: `text("INSERT OR IGNORE INTO app_settings (key, value) VALUES (:key, :value)")` with `{"key": key, "value": value}`.

### 1.5 [HIGH] Backend port not exposed in docker-compose.yml but accessible on host network in some configurations

`backend` has no `ports:` mapping, which is correct for the default compose file. However, the README instructs developers to run `uvicorn --host 0.0.0.0 --port 8000` locally, and the backend Dockerfile also binds to `0.0.0.0:8000`. A developer who runs the backend outside Docker (e.g. for debugging) exposes an unauthenticated API on their machine network interface.

### 1.6 [HIGH] Hardcoded SNMP passwords in seed data – `backend/seed_db.py` lines 205-225

Seed profiles and credentials contain real-looking passwords:

```python
v3_auth_password = "Auth@FS_Global#2026",
v3_priv_password = "Priv@FS_Global#2026",
```

These are also constructed procedurally per-device (`Auth@RACK-A00#2026`). If a developer accidentally runs `seed_db.py` against a production database, these would become valid credentials in the export. The seed file is fine for testing, but it should either use clearly fictional values (e.g. `CHANGEME_auth_password`) or be excluded from the Docker image.

### 1.7 [MEDIUM] SNMP community string `"public"` is the default for all schemas

`community = "public"` is the default in `CredentialBase`, `SnmpProfileBase`, and the fallback in `_execute_scan`. This is the industry-standard insecure default. The UI should warn the user when this default is left unchanged rather than silently accepting it.

### 1.8 [MEDIUM] No HTTPS in Docker deployment

The frontend nginx configuration (`frontend/nginx.conf`) only listens on port 80. All traffic (including SNMP credentials entered in the browser) traverses the network unencrypted. For a LAN tool this is common but should at minimum be documented as a known limitation.

### 1.9 [MEDIUM] Map background image upload stored without content-type validation – `backend/main.py`

The `POST /api/map-bg` endpoint accepts `UploadFile` and stores the file in `/data/map_bg`. While `SettingsPage.jsx` uses `accept="image/*"` on the file input, this is a client-side hint only. The backend performs no MIME-type or magic-byte check, meaning an attacker could upload arbitrary binary content.

### 1.10 [LOW] Background ping command uses Linux-only flags

```python
cmd = ["ping", "-c", "1", "-W", str(timeout_sec), ip]
```

This is hardcoded for Linux/macOS. In Windows environments (e.g. bare-metal development without WSL), `-c` is not a valid ping flag, causing all ping attempts to silently fail and return `(False, 0)`. The Windows equivalent is `ping -n 1 -w <ms>`. The current code has a try/except that returns `(False, 0)` on any Exception, so this failure is silent.

---

## 2. Code Quality

### 2.1 [HIGH] `main.py` is 2066 lines – monolithic structure

The entire backend (scan orchestration, CRUD for 8+ resource types, background scheduler, config export/import, bulk import, file upload) lives in one file. This makes navigation, testing, and maintenance extremely difficult. Suggested structure:
```
backend/
  routers/
    credentials.py
    devices.py
    scan.py
    racks.py
    settings.py
  services/
    scan_service.py
    scheduler.py
```

### 2.2 [HIGH] `SettingsPage.jsx` is 2071 lines

The entire settings UI is a single component file. Each tab (Credentials, SNMP Profiles, Racks, Switch Classes, Switch Models, Scan Settings, DNS, Map, Import/Export) should be its own file. This file is essentially unmaintainable at its current size.

### 2.3 [HIGH] `MapPage.jsx` is 1108 lines

Similar issue – the topology SVG, rack list panel, filter bar, active link bar, and all interaction logic reside in a single file. The SVG `TopologyMap` component alone should be extracted.

### 2.4 [MEDIUM] Confusing dual naming for the same class – `backend/main.py` line 27

```python
from database import SwitchModel as SwitchModelModel
```

`SwitchModel` is the SQLAlchemy ORM class. It is imported as `SwitchModelModel` because Pydantic also defines `SwitchModelOut` / `SwitchModelCreate`. The classes should be renamed at source (e.g. `SwitchModelDB` or `SwitchModelOrm`) to avoid this aliasing antipattern.

### 2.5 [MEDIUM] Dead/placeholder code in `SettingsPage.jsx` lines 300-330

The `editState.id` ghost placeholder (the static read-only card shown while the floating edit form is visible) is rendered server-side but shows dummy data ("Core Switch RZ-01", "192.168.1.1", "public"). This placeholder is never meaningfully populated and is displayed in an invisible way (zero-height or behind the floating form), but it still exists in the DOM.

### 2.6 [MEDIUM] Inline styles pervasive throughout frontend

Every component defines styles as JavaScript objects inline or via style literals. This results in:
- No style reuse between components (e.g. `inp`, `sel`, `btnStyle` are redefined in every tab component of `SettingsPage.jsx`)
- No media query support
- Poor performance (new object allocations each render for deeply nested structures)

A shared design token module or CSS Modules / Tailwind would significantly reduce duplication.

### 2.7 [MEDIUM] `_log_event` in `main.py` imports `re` inside a nested async function

```python
import re as _re   # inside _ping_host_async
```

This import is inside a hot code path (called once per scan target per scan). While Python caches imports, this is an antipattern that obscures dependencies and slightly slows the first call. `re` is already used in `snmp_scanner.py` and should be imported at module level in `main.py`.

### 2.8 [MEDIUM] Duplicate speedLabel implementations

`speedLabel` / `speed_label` is implemented identically in both `backend/snmp_scanner.py` (Python) and `frontend/src/api.js` (JavaScript). While a frontend/backend split is natural, the two differ slightly in their threshold for the `"10G"` label (`>= 10_000` Mbps in Python vs `>= 10000` in JS). Both are technically identical but should be noted as a maintenance risk – a change to one must be manually mirrored.

### 2.9 [LOW] `snmp_scanner.py` SHA-256 mapped to wrong protocol constant

```python
"SHA-256": usmHMAC192SHA256AuthProtocol,
```

The mapping name is `usmHMAC192SHA256AuthProtocol` – this is pysnmp's name for SHA-256, but the "192" in the constant name refers to the HMAC key size, not the hash. The mapping is functionally correct but counterintuitive and may confuse future maintainers working with pysnmp docs.

### 2.10 [LOW] `ScanResult.status` default is `"finished"` but scans can end as `"cancelled"` or `"dry_run"`

The `ScanResult` Pydantic schema defaults `status` to `"finished"`, which is misleading when a scan is aborted. The actual status is set correctly at runtime, but the default suggests the model was not designed defensively.

---

## 3. Architecture

### 3.1 [HIGH] Background scheduler shares a `Session` across multiple async event loops

`_background_scheduler` creates one `SessionLocal()` database session and then creates separate `asyncio` event loops for each scan type. The same `db` session is passed to `_execute_scan` running in different loops:

```python
db = SessionLocal()
loop = asyncio.new_event_loop()
loop.run_until_complete(_execute_scan(db, scan_type="discovery"))
...
loop = asyncio.new_event_loop()
loop.run_until_complete(_execute_scan(db, scan_type="links"))
```

SQLAlchemy sessions are not thread-safe and not designed to be passed across event loops. If `_execute_scan` commits or rolls back during one loop and the session is reused in the next, stale state or lock contention can occur. Each `_execute_scan` call should create its own `SessionLocal()` and close it afterward.

### 3.2 [HIGH] No database migration framework

Schema evolution is handled by a series of `_ensure_*` functions that issue raw `ALTER TABLE` statements at startup. While this works for a single-developer SQLite project, it has significant drawbacks:
- No version tracking or rollback
- Adding future columns requires adding new `_ensure_*` functions (pattern grows unboundedly)
- Incompatible with a future migration to PostgreSQL
- The `_ensure_app_settings_table` function contains hardcoded default rows inserted with f-string interpolation (see 1.4)

Alembic is a natural fit given SQLAlchemy is already in use.

### 3.3 [MEDIUM] Credential model duplicates all SNMP fields from SnmpProfile

Every `Credential` row stores a full copy of the profile's SNMP fields (`snmp_version`, `community`, `v3_auth_password`, etc.) even when a `profile_id` is set. The `update_snmp_profile` endpoint explicitly propagates all fields to linked credentials:

```python
db.query(Credential).filter(Credential.profile_id == profile_id).update({
    "snmp_version": profile.snmp_version,
    ...
})
```

This bidirectional synchronisation is fragile. The canonical pattern is to keep the per-credential columns only for credentials that do *not* use a profile, and read from the profile at scan time for those that do. The scan code already does this (`p.snmp_version if p else cred.snmp_version`), making the synchronisation redundant.

### 3.4 [MEDIUM] `auto_layout` in `snmp_scanner.py` is unused at runtime

The `auto_layout` function places nodes in a circle and is imported in `main.py`. It is called in only one code path (when new devices are discovered via range probes and have no existing map position). However, the function is defined in `snmp_scanner.py`, which is otherwise a pure SNMP I/O module. This is a separation-of-concerns violation; layout logic belongs in `main.py` or a dedicated layout module.

### 3.5 [MEDIUM] Log buffer is in-process memory only

`LOG_BUFFER` is a `deque(maxlen=5000)` in `main.py`. The backend is configured with `--workers 1` in the Dockerfile CMD, so there is only one worker process and this works. However, if workers were ever increased (e.g. `--workers 2`), each process would have its own `LOG_BUFFER` and logs would be fragmented. The constraint on workers should be documented, or the log buffer should be moved to the database / a shared store.

### 3.6 [LOW] `ScanRun` stores full device/link snapshots as JSON blobs

```python
devices_snapshot_json = Column(Text, default="[]")
links_snapshot_json   = Column(Text, default="[]")
```

These snapshots store stringified lists of IPs/keys. Storing structured data as JSON text in SQLite is acceptable for small datasets but prevents efficient querying (e.g. "which scan first discovered IP 10.0.1.1"). If scan history becomes important, normalised tables would be preferable.

---

## 4. Performance

### 4.1 [HIGH] N+1 query risk in `GET /api/topology`

The topology endpoint loads all devices, their ports, racks, classes, and models. SQLAlchemy relationships (`ports`, `rack`, `switch_class`, `switch_model`) will default to lazy loading unless explicitly configured. Each device accessed in the response loop may issue a separate `SELECT` for its `ports` list. With 25+ devices (as in the seed data), this is a minimum of 25 extra queries per page load. The relationship definitions in `database.py` should use `lazy="subquery"` or eager load with `joinedload`/`selectinload` in the endpoint query.

### 4.2 [MEDIUM] Dashboard statistics computed client-side from full topology payload

`DashboardPage.jsx` calls `GET /api/topology` to compute summary statistics (device count, port utilisation, rack summaries). The topology response includes all port data for all devices – for a production network with hundreds of devices and dozens of ports each, this transfers several hundred KB of JSON per page load. A dedicated `GET /api/stats` endpoint would be far more efficient.

### 4.3 [MEDIUM] `LogsPage.jsx` polls every 5 seconds unconditionally during auto-refresh

```javascript
const t = setInterval(loadLogs, 5000);
```

The interval is not paused when the browser tab is not visible (`document.visibilityState`). On a busy network this generates a constant stream of API calls even when the user has navigated away from the Logs tab. Use the Page Visibility API to suppress polling when hidden.

### 4.4 [MEDIUM] ETag caching in `api.js` only applies to `GET` requests, but errors are not cached differently

```javascript
if (!r.ok) return r.json();
```

On a failed (non-2xx, non-304) response, `api.get` still returns the JSON body, but does **not** throw. Callers that `await api.get(...)` receive an error object (`{ detail: "..." }`) silently as regular data. This means errors are silently swallowed in most call sites (`DashboardPage`, `LogsPage`, etc.), and the UI simply shows stale or empty state with no user-facing error message.

### 4.5 [LOW] `_expand_ranges_to_ips` builds a list of up to 65,536 strings in memory

The function protects against larger ranges (`> 65536`) but still materialises up to 65,536 string objects in memory before the scan (iterating `network.hosts()` into a Python list). For a /16 network this is borderline acceptable but could be batched as a generator.

---

## 5. Error Handling

### 5.1 [HIGH] API client never throws on HTTP errors – `frontend/src/api.js` lines 10-24

As noted in 4.4, the `api.get` helper returns the response JSON regardless of HTTP status. The `post`, `put`, and `patch` methods similarly call `.then(r => r.json())` without checking `r.ok`. This means a `500 Internal Server Error` from the backend is returned to caller code as `{ detail: "Internal Server Error" }` – indistinguishable from a successful response. All methods in `api.js` should throw on non-2xx responses:

```javascript
post: async (path, body) => {
  const r = await fetch(...);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
```

### 5.2 [HIGH] Background scheduler exceptions are silently swallowed

```python
except Exception as e:
    _log_event(logging.ERROR, "scheduler.error", error=str(e))
```

A crash in `_execute_scan` (e.g. a DB connection error, import error, or unhandled exception from pysnmp) will cause all future scheduled scans to stop silently if the exception occurs before `last_discovery` is updated. The scheduler loop continues but `_execute_scan` is not re-queued. The loop should track and log whether its period timers were actually updated.

### 5.3 [MEDIUM] `snmp_scanner.py` silently discards all SNMP errors at DEBUG level

```python
except Exception as exc:
    log.debug("snmp_get %s: %s", ip, exc)
```

SNMP transport errors, authentication failures, and timeout exceptions are all logged at `DEBUG` (not visible in production). Operators have no way to distinguish "host unreachable" from "wrong credentials" from "pysnmp internal error" without turning on DEBUG logging. At minimum, `AuthenticationError` and connection refused should be logged at `WARNING`.

### 5.4 [MEDIUM] `SnmpEngine` dispatcher not closed on exception path in `snmp_get`

```python
finally:
    try:
        engine.transportDispatcher.closeDispatcher()
    except Exception:
        pass
```

The outer `try/except` in `snmp_get` catches all exceptions and returns an empty dict. The `finally` block attempts to close the dispatcher. However, if `getCmd(...)` itself raises before yielding (e.g. a transport initialisation failure), the dispatcher may never have been opened, and the `closeDispatcher()` call is a no-op. This is safe but untested – the `pass` masks any cleanup errors that might be meaningful.

### 5.5 [MEDIUM] `CredentialsTabContent` calls `Promise.all` but catches at collection level only

```javascript
Promise.all([
  api.get("/api/credentials"),
  api.get("/api/topology"),
  api.get("/api/racks"),
  api.get("/api/switch-classes"),
])
  .then(([c, t, r, cl]) => { ... })
  .catch(() => setLoading(false));
```

On any single API failure, all four results are discarded and the component shows the loading spinner indefinitely (`setLoading(false)` is called but `setCreds` is never called with data, leaving an empty list). Partial data should be shown on partial failures.

### 5.6 [LOW] `Port.jsx` silently catches JSON parse errors

```javascript
try {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(value) ? value : [];
} catch {
  return [];
}
```

This is an intentional defensive pattern but could mask malformed data stored in the backend. A `console.warn` on the catch path would aid debugging.

---

## 6. API Design

### 6.1 [MEDIUM] `POST /api/scan` mixes resource creation and action semantics

`POST /api/scan` triggers a side-effectful scan operation and returns a `ScanResult`. This is an acceptable REST pattern for long-running actions, but the endpoint also returns scan runs via `GET /api/scan-runs`, creating inconsistency. The trigger endpoint should return the created `ScanRun` resource (with `id`) so clients can poll `GET /api/scan-runs/{id}` for status. Currently the scan is synchronous (blocking the HTTP request for the full scan duration), which is a related concern.

### 6.2 [MEDIUM] `GET /api/logs` returns a list but the ETag cache key in the frontend is the full path with dynamic query params

```javascript
const query = `/api/logs?limit=...${levelFilter}...${textFilter}...`;
api.get(query)
```

Each unique combination of filters creates a new ETag cache entry. On a page where filters change frequently, the cache becomes unbounded in memory (the `_etagCache` object grows without eviction). The cache should be capped or the logs endpoint excluded from ETag caching.

### 6.3 [MEDIUM] `PATCH /api/devices/{id}/position` and `PUT /api/devices/{id}/meta` use inconsistent HTTP methods

Position updates use `PATCH`, metadata updates use `PUT`, and rack position updates also use `PATCH`. This mixture is reasonable but not consistent. `PUT` for partial updates is incorrect REST semantics—`PUT` replaces the entire resource. These should all be `PATCH`.

### 6.4 [LOW] `GET /api/bulk-export/{kind}` uses a query parameter `format` that shadows Python's built-in `format`

```python
def bulk_export(kind: str, format: str = "json", ...):
```

The local variable `format` shadows Python's built-in `format()` function inside that scope. Rename to `fmt` (which is already used internally) as the parameter name.

### 6.5 [LOW] `DELETE` endpoints return 204 even when the resource was not found in some cases

`delete_rack`, `delete_switch_class`, `delete_switch_model` all return 404 if the resource is missing. `delete_credential` similarly. This is correct, but the pattern should be audited across all delete handlers to ensure consistency.

---

## 7. Frontend

### 7.1 [HIGH] No React error boundaries

There are no `ErrorBoundary` components anywhere in the frontend. A JavaScript error in any page component (e.g. accessing `.length` on `undefined` when the API returns an unexpected shape) will crash the entire application and show a blank screen with no recovery path.

### 7.2 [HIGH] Zoom state persisted to `localStorage` with no schema validation – `MapPage.jsx`

```javascript
const [zoom, setZoom] = useState(() => {
  try {
    const s = localStorage.getItem("netmap-zoom");
    if (s) return JSON.parse(s);
  } catch {}
  return { scale:1, tx:0, ty:0 };
});
```

If the stored value is valid JSON but has the wrong shape (e.g. `{"scale": "abc"}`), it is used directly without validation, potentially causing NaN propagation in SVG transforms. Add a shape guard.

### 7.3 [MEDIUM] `window.confirm` used for destructive actions

`SettingsPage.jsx` uses `confirm("Delete profile?")` and `confirm("Delete credential?")`. `window.confirm` is synchronous, blocks the UI thread, and is suppressed in iframes and some browser configurations. A custom inline confirmation state (already partially implemented elsewhere in the UI) should be used instead.

### 7.4 [MEDIUM] No loading/error states for topology in `MapPage.jsx`

`MapPage.jsx` calls `api.get("/api/topology")` on mount, but if the call fails (network error, backend down), the page renders with empty racks and nodes without any visible error message. A "Failed to load" state should be displayed.

### 7.5 [MEDIUM] Accessibility (a11y) issues throughout

- Navigation uses `<NavLink>` with `<span>` children but no ARIA roles or `aria-current` attributes (React Router's `NavLink` does add these, but inline styles override the active appearance completely, making the visual state dependent entirely on JS logic).
- Interactive `<div>` elements (e.g. rack nodes in the SVG, port cells) use `onClick` handlers but lack `role="button"`, `tabIndex`, and keyboard event handlers (`onKeyDown`). These are inaccessible to keyboard and screen reader users.
- Icon buttons in `ActiveLinkBar` use the literal string `"X"` (see line 24 of `MapPage.jsx`) and `"<->"` as labels — not semantic or accessible.
- Form labels in `SettingsPage.jsx` wrap `<input>` elements directly (correct pattern), but several use `<div>` as label containers instead of `<label>`.

### 7.6 [MEDIUM] `App.jsx` injects `@import` in a `<style>` tag on every render

```jsx
<style>{`
  @import url('https://fonts.googleapis.com/css2?family=Inter...');
  ...
`}</style>
```

`@import` inside a `<style>` tag is valid CSS but is the slowest loading mechanism for external stylesheets (it must be parsed before the browser discovers the external resource). This Google Fonts load also blocks rendering. Use `<link rel="preload">` in `index.html` or a `<link rel="stylesheet">` in `<head>`.

Additionally, the global style reset (`*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }`) is injected into every render. If React re-renders `App`, the browser must reparse these styles.

### 7.7 [LOW] Font size override hack in `App.jsx`

```css
[style*="font-size: 8px"], [style*="font-size: 9px"], ... { font-size: 12px !important; }
```

This is a brute-force override for inline styles, suggesting some components set very small font sizes that were later deemed too small. The proper fix is to remove the sub-12px inline font-size declarations from the components (particularly `Port.jsx` which uses `fontSize:8` and `fontSize:10`), not to override them with a global selector hack.

### 7.8 [LOW] `key={idx}` used in list rendering in `LogsPage.jsx`

```jsx
rows.map((entry, idx) => (
  <div key={idx} ...>
```

Using array index as a React key causes unnecessary reconciliation when rows are inserted or removed. Since log entries have a `ts` (timestamp) field, use a composite key such as `key={entry.ts + idx}` or a UUID if available.

---

## 8. Docker / Deployment

### 8.1 [HIGH] Backend Dockerfile runs as root

The backend Dockerfile has no `USER` directive. The uvicorn process runs as root inside the container. If a vulnerability in FastAPI, pysnmp, or the scan code allows code execution, the attacker has root privileges in the container (which may map to root on the host if volumes are misconfigured).

Add:
```dockerfile
RUN adduser --disabled-password --gecos "" appuser && chown -R appuser /app /data
USER appuser
```

### 8.2 [MEDIUM] Frontend Dockerfile uses `npm install` without a lockfile fallback

```dockerfile
COPY package.json package-lock.json* ./
RUN npm install
```

The `package-lock.json*` glob copies the lockfile if it exists. If it does not exist (e.g. after a fresh clone on Windows that strips it), `npm install` resolves to the latest compatible versions, potentially breaking the build. Use `npm ci` (which requires a lockfile and is reproducible) instead of `npm install`.

### 8.3 [MEDIUM] No health checks in docker-compose.yml

Neither service has a `healthcheck:` definition. Docker Compose's `depends_on: backend` does not wait for the backend to be ready – only for the container to start. The frontend nginx may attempt to proxy requests before the backend has completed startup (table creation, migrations). A simple health check endpoint (`GET /health`) and a `depends_on: condition: service_healthy` would prevent this race.

### 8.4 [MEDIUM] SQLite database file not protected at OS level

The database is mounted at `/data/netmap.db` in the container. As long as the backend runs as root (see 8.1), the file is world-readable/writable within the container. Combined with the absence of authentication, an attacker who can exec into the container has full access to all stored credentials.

### 8.5 [LOW] `iputils-ping` installed in backend image but `ping` is Linux-only on the code path

The backend installs `iputils-ping` via `apt-get` specifically to enable the ping functionality. The `_ping_host_async` function hardcodes Linux `ping -c 1 -W N` flags. This is correct for the Docker deployment but will fail silently in local Windows development (see 1.10). The Dockerfile comment should note this dependency.

### 8.6 [LOW] Backend Dockerfile copies entire source directory including development files

```dockerfile
COPY . .
```

This copies `seed_db.py`, `snmp_scanner.py.bak`, `requirements.txt` (already installed), and any other files in the directory into the image. A `.dockerignore` file would reduce image size and prevent accidental inclusion of local development state (`.env` files, test data, etc.).

---

## 9. Missing Functionality / Bugs

### 9.1 [HIGH] Scan endpoint is fully synchronous — blocks for the entire scan duration

`POST /api/scan` is a synchronous FastAPI route that calls `asyncio.run(_execute_scan(...))`:

```python
@app.post("/api/scan", ...)
def trigger_scan(body: ..., db: Session = Depends(get_db)):
    ...
    result = asyncio.run(_execute_scan(db, ...))
    return result
```

For a network with many switches (25+ in the seed data), each with a 3-second SNMP timeout and 1 retry, a scan could block the HTTP request for 30–120 seconds. FastAPI runs synchronous routes in a threadpool, so other API calls remain responsive, but the frontend HTTP client will time out (nginx has `proxy_read_timeout 300s`, which may be sufficient but is not guaranteed). The scan should be made asynchronous: return a job ID immediately and allow the client to poll for status.

### 9.2 [HIGH] Port key collision when multiple switches share the same IP

Port keys in the frontend are constructed as:
```javascript
const pKey = `${device.ip}:${port.if_descr}`;
```

If two devices somehow share the same IP (e.g. after a scan and manual data manipulation), their port keys will collide in `portLinkMap` and the wrong link data will be displayed. The backend enforces `unique=True` on `Device.ip`, but the frontend should be defensive.

### 9.3 [MEDIUM] `snmp_scanner.py.bak` in the repository

A `.bak` backup file of the scanner exists in `backend/`. This should not be committed to version control. It also gets copied into the Docker image (see 8.6).

### 9.4 [MEDIUM] `bundle_debug.js` in the repository root

A `bundle_debug.js` file exists at the workspace root. This appears to be a build artifact that was accidentally committed. It should be added to `.gitignore`.

### 9.5 [MEDIUM] `fix_encoding.py` in the repository root

A `fix_encoding.py` script exists at the workspace root with no associated documentation. It is unclear whether this is a utility, a one-time migration, or dead code. It should either be documented and moved to a `scripts/` directory or deleted.

### 9.6 [MEDIUM] `todo.md` committed to the repository

A `todo.md` file is tracked in version control. Development task tracking should use a proper issue tracker, not a committed file. At minimum it should be added to `.gitignore`.

### 9.7 [LOW] `VITE_API_URL` is baked at build time — cannot change runtime

The `VITE_API_URL` variable is resolved at `npm run build` time (Vite replaces `import.meta.env.VITE_API_URL` with a literal string in the output bundle). This means the Docker image cannot be pointed at a different backend URL without rebuilding. Either document this clearly or use a runtime configuration approach (e.g. a `config.json` fetched at startup).

### 9.8 [LOW] `index.html` title is too specific

```html
<title>NetMap - Aruba CX Topology</title>
```

The application supports multiple vendors (Aruba CX, FS.com, UniFi, Generic). "Aruba CX Topology" implies a product-specific tool. The title should be updated to "NetMap".

---

## 10. Dependencies

### 10.1 [MEDIUM] `pysnmp-lextudio==5.0.34` is a community fork

The project uses `pysnmp-lextudio`, which is a continuation fork of the original (abandoned) `pysnmp` library. This fork is actively maintained but has a smaller community and fewer guarantees about long-term support. This is a pragmatic choice (the original `pysnmp` is unmaintained), but the dependency should be monitored and documented.

### 10.2 [MEDIUM] `pyasn1==0.4.8` is pinned to a very old version

`pyasn1` 0.4.8 was released in 2019. The current version is 0.6.x. The old pin is likely a transitive dependency constraint from `pysnmp-lextudio`, but it should be audited to ensure there are no known CVEs in this version range.

### 10.3 [LOW] No `package-lock.json` visible in the workspace listing

The workspace listing shows no `package-lock.json` in `frontend/`. If this file is not committed, `npm install` in CI/CD and Docker builds is non-reproducible. Run `npm install` locally to generate and commit the lockfile.

### 10.4 [LOW] `react-router-dom ^6.28.0` — using caret range

All three React dependencies use `^` ranges in `package.json`. This is standard practice combined with a lockfile, but without a committed lockfile (see 10.3), patch-level changes could break the build.

---

## Summary of Most Important Findings

| # | Severity | File(s) | Issue |
|---|---|---|---|
| 1.2 | CRITICAL | `schemas.py`, `main.py` | SNMP passwords returned in plaintext in all API responses |
| 1.3 | CRITICAL | `main.py` | Zero authentication on all API endpoints |
| 1.1 | CRITICAL | `main.py` | `allow_credentials=True` + `allow_origins=["*"]` is invalid and insecure |
| 1.4 | HIGH | `database.py` | SQL injection-prone f-string `text()` calls |
| 3.1 | HIGH | `main.py` | Scheduler passes same DB session across multiple async loops |
| 9.1 | HIGH | `main.py` | `POST /api/scan` is fully synchronous — can block for 100+ seconds |
| 5.1 | HIGH | `api.js` | API client never throws on HTTP errors — errors silently treated as data |
| 8.1 | HIGH | `backend/Dockerfile` | Backend container runs as root |
| 2.1 | HIGH | `main.py` | 2066-line monolith — unmaintainable |
| 7.1 | HIGH | Frontend | No React error boundaries — any JS error shows blank screen |
| 3.2 | HIGH | `database.py` | No migration framework — ad-hoc `ALTER TABLE` accumulation |

---

*Document created by automated code review agent. All line numbers reference the state of the codebase at the time of review (2026-02-23).*
