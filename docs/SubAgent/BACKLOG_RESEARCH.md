# Backlog Items Research Analysis

Research document covering feasibility and implementation details for 8 backlog items from the NetMap code review.

---

## 1. WebSocket Ticket-Based Auth (SEC-5)

### Current Implementation
- [ws.py](backend/routers/ws.py) accepts a `token` query parameter on the `/ws/scan-progress` endpoint.
- `_authenticate_ws()` checks the JWT or legacy `SECRET_TOKEN` directly from the query string.
- This means the raw JWT is exposed in server logs, browser history, and network intermediaries via the URL query string.

### What Needs to Change
1. New endpoint `POST /api/auth/ws-ticket` that:
   - Requires standard Bearer JWT auth (existing `_require_auth` middleware handles this).
   - Generates a short-lived single-use ticket (random UUID or opaque token).
   - Stores the ticket in Redis with a TTL (e.g., 30 seconds) and marks the user identity on it.
2. Modify `_authenticate_ws()` to:
   - Accept the ticket instead of the JWT.
   - Look up the ticket in Redis, validate it, consume it (delete after use).
   - Reject reused tickets.
3. Frontend change in `useScanProgress.js` (or wherever the WebSocket connects):
   - Before connecting, call `POST /api/auth/ws-ticket` to get a ticket.
   - Pass the ticket as the query parameter instead of the JWT.

### Files Involved
- [backend/routers/ws.py](backend/routers/ws.py) - modify `_authenticate_ws()`
- [backend/routers/auth.py](backend/routers/auth.py) - add `/api/auth/ws-ticket` endpoint
- [backend/shared/auth.py](backend/shared/auth.py) - add `_AUTH_EXEMPT_PATHS` entry or keep it behind auth
- [backend/shared/redis_client.py](backend/shared/redis_client.py) - ticket storage
- [frontend/src/hooks/useScanProgress.js](frontend/src/hooks/useScanProgress.js) - ticket exchange before WS connect

### Complexity: Small
- Straightforward pattern: generate token, store in Redis with TTL, consume on WS connect.
- Redis dependency already exists and is used for topology caching and scan state.

### Dependencies
- None. Can be implemented independently.

### Risk Assessment
- **Low risk.** The fallback path (auth disabled) already exists. If Redis is unavailable, the ticket endpoint could return an error and the frontend could fall back to the current JWT-in-query approach, though this would reduce the security benefit. Need to decide: hard-fail or graceful degradation when Redis is down.

---

## 2. JWT Token Refresh Mechanism

### Current Implementation
- [shared/auth.py](backend/shared/auth.py) creates tokens with `JWT_EXPIRY_HOURS` (default 24h). Tokens are single-issue, no refresh flow.
- [auth.py router](backend/routers/auth.py) has only `POST /api/auth/login` and `GET /api/auth/me`.
- Frontend [api.js](frontend/src/api.js) has `getTokenExpiry()` and `isTokenExpiringSoon()` utilities already implemented (added in v1.12.0) but they are **never called** -- no auto-refresh logic uses them.
- On 401 response, `_checkOk()` in api.js clears the token and redirects to `/login`.

### What Needs to Change
1. Backend `POST /api/auth/refresh` endpoint:
   - Accepts a valid (non-expired or recently-expired) JWT.
   - Verifies the user still exists and is active in the database.
   - Issues a new JWT with a fresh expiry.
   - Should accept tokens within a grace window (e.g., up to 1 hour past expiry) to handle edge cases.
2. Frontend auto-refresh logic:
   - On app load or before API calls, check `isTokenExpiringSoon()`.
   - If expiring soon, call `/api/auth/refresh` to get a new token.
   - Update `localStorage` with the new token via the existing `login()` function.
   - Could be implemented as an interceptor in `api.js` or a periodic check in `App.jsx`.
3. Rate limit the refresh endpoint (e.g., 10/minute) to prevent abuse.

### Files Involved
- [backend/routers/auth.py](backend/routers/auth.py) - add refresh endpoint
- [backend/shared/auth.py](backend/shared/auth.py) - optionally add `decode_token_allow_expired()` helper
- [frontend/src/api.js](frontend/src/api.js) - add refresh interceptor logic using existing `isTokenExpiringSoon()`
- [frontend/src/App.jsx](frontend/src/App.jsx) - optionally add periodic refresh check

### Complexity: Small
- Backend is a simple endpoint: decode token, verify user, issue new token.
- Frontend already has the expiry detection utilities; just needs the refresh call.

### Dependencies
- None. Independent of other items.

### Risk Assessment
- **Low risk.** The worst case is the refresh fails and the user gets logged out (current behavior). Need to handle the race condition where multiple tabs could try refreshing simultaneously -- use the same token or implement token rotation with a short grace period for the old token.

---

## 3. Rate Limiting for Scan + Settings Endpoints

### Current Implementation
- Rate limiting uses `slowapi` (a FastAPI wrapper around `limits`).
- **Already rate-limited:**
  - `POST /api/auth/login` - 5/minute ([auth.py L21](backend/routers/auth.py))
  - `POST /api/scan` (deprecated sync) - 2/minute ([scan.py L24](backend/routers/scan.py))
  - `POST /api/scan/jobs` - 5/minute ([scan.py L31](backend/routers/scan.py))
  - `POST /api/map-background` - 5/minute ([map_bg.py L50](backend/routers/map_bg.py))
- **NOT rate-limited (should be):**
  - `PUT /api/settings/{key}` - admin/operator only, but no rate limit
  - `POST /api/credentials` - admin/operator only, no rate limit
  - `PUT /api/credentials/{cred_id}` - admin/operator only, no rate limit
  - `DELETE /api/credentials/{cred_id}` - admin/operator only, no rate limit
  - `POST /api/scan/dry-run/jobs` - **no auth at all** and no rate limit (potential abuse vector)
  - User management endpoints (POST/PUT/DELETE /api/users/*) - admin only, no rate limit

### What Needs to Change
1. Add rate limiting to the identified endpoints:
   - `PUT /api/settings/{key}` - 10/minute (settings changes are rare)
   - `POST /api/credentials` - 10/minute
   - `PUT/DELETE /api/credentials/{cred_id}` - 10/minute
   - `POST /api/scan/dry-run/jobs` - 3/minute (also needs auth added -- security gap)
   - User management endpoints - 10/minute
2. The pattern is already established: import `Limiter` from slowapi, apply `@limiter.limit()` decorator.
3. Consider a global rate limiter for all authenticated endpoints as a safety net.

### Files Involved
- [backend/routers/settings.py](backend/routers/settings.py) - add limiter
- [backend/routers/credentials.py](backend/routers/credentials.py) - add limiter
- [backend/routers/scan.py](backend/routers/scan.py) - add limiter to dry-run + add auth
- [backend/routers/auth.py](backend/routers/auth.py) - add limiter to user management

### Complexity: Small
- Copy the existing pattern from auth.py/scan.py. Each endpoint just needs a decorator.
- The `POST /api/scan/dry-run/jobs` missing auth is a separate security fix that should be prioritized.

### Dependencies
- None. Independent of other items.

### Risk Assessment
- **Low risk.** The slowapi library is already integrated. The main concern is choosing appropriate limits -- too aggressive may block legitimate admin operations. The dry-run endpoint missing auth is a higher-priority finding.

---

## 4. Scan Engine Modularization

### Current Implementation
- [scan_engine.py](backend/scan_engine.py) is a ~1340-line monolithic file containing:
  - **Broadcasting helpers** (L35-65): `_broadcast_progress()`, `_broadcast_scan_complete()`
  - **Event loop management** (L68-92): `_get_bg_loop()`, shared background asyncio loop
  - **Ping helpers** (L97-140): `_build_ping_cmd()`, `_ping_host()`
  - **Scan data helpers** (L145-320): JSON parsing, link keys, scan run persistence, discovery range expansion, DNS resolution/caching
  - **Core scan engine** (L325-1115): `_execute_scan()` -- the 790-line async function that does everything: credential resolution, SNMP scanning, device upsert, port update, link update, dry-run handling, auto-credential creation, Prometheus metrics
  - **Job management** (L1118-1200): `_run_scan_job()`, `_start_job()`
  - **Background scheduler** (L1206-1340): `_dispatch_scheduled_scan()`, `_background_scheduler()`

### What Needs to Change
Extract into logical modules under a new `backend/scan/` package:

| Module | Contents | Lines (approx) |
|--------|----------|-----------------|
| `scan/__init__.py` | Package exports | ~10 |
| `scan/broadcast.py` | `_broadcast_progress`, `_broadcast_scan_complete`, `_get_bg_loop` | ~70 |
| `scan/ping.py` | `_build_ping_cmd`, `_ping_host`, `_ping_host_async` | ~80 |
| `scan/dns.py` | `_resolve_host`, `_resolve_ip`, `_evict_dns_cache`, DNS cache | ~100 |
| `scan/helpers.py` | `_safe_json_list`, `_canonical_link_key`, `_read_discovery_ranges`, `_expand_ranges_to_ips` | ~60 |
| `scan/persistence.py` | `_persist_scan_run`, device upsert logic, port update, link update | ~350 |
| `scan/engine.py` | `_execute_scan` (orchestrator calling other modules) | ~300 |
| `scan/jobs.py` | `_run_scan_job`, `_start_job` | ~80 |
| `scan/scheduler.py` | `_background_scheduler`, `_dispatch_scheduled_scan`, `_scheduler_wake` | ~100 |

### Files Involved
- [backend/scan_engine.py](backend/scan_engine.py) - decompose into modules
- New `backend/scan/` package (8-9 new files)
- [backend/routers/scan.py](backend/routers/scan.py) - update imports
- [backend/routers/ws.py](backend/routers/ws.py) - update import of `_get_bg_loop`
- [backend/tasks.py](backend/tasks.py) - update import of `_execute_scan`
- [backend/main.py](backend/main.py) - update scheduler startup import

### Complexity: Large
- The `_execute_scan` function is 790 lines with deep coupling between phases (port update references data from scan phase, link update references data from port phase).
- Extracting sub-functions requires careful parameter passing -- the function currently uses many local variables shared across phases.
- High test risk: no unit tests exist for `scan_engine.py` -- only integration tests through API endpoints.

### Dependencies
- Should be done **before** item 5 (Celery Beat migration) since the scheduler code will move to a separate module.
- Independent of all other items.

### Risk Assessment
- **Medium-high risk.** Large refactor with no direct test coverage of the scan engine internals. The `_execute_scan` function is the core of the application. Should be done incrementally:
  1. First extract helpers/utilities (broadcast, ping, DNS) -- low risk.
  2. Then extract scheduler and job management -- medium risk.
  3. Finally decompose `_execute_scan` -- highest risk, needs thorough manual testing.

---

## 5. Celery Beat Scheduler Migration

### Current Implementation
- [scan_engine.py L1256-1340](backend/scan_engine.py): `_background_scheduler()` runs in a daemon thread started from `main.py`.
- It loops every 5 seconds (via `_scheduler_wake.wait(timeout=5)`), reads interval settings from the database, and dispatches scans when enough time has elapsed.
- Three independent timers: discovery, links, macs.
- Dispatches via `_dispatch_scheduled_scan()` which tries Celery first, falls back to direct execution with the background event loop.
- [celery_app.py](backend/celery_app.py) configures Celery but does **not** configure `beat_schedule`.

### What Needs to Change
1. Add `celery_app.conf.beat_schedule` in [celery_app.py](backend/celery_app.py) with entries for:
   - `discovery-scan`: runs every N seconds (configurable)
   - `link-update`: runs every N seconds
   - `mac-update`: runs every N seconds
2. The challenge: intervals are stored in the database (`AppSetting` table), not in environment variables. Celery Beat needs a dynamic schedule source. Options:
   - **Option A:** Use `django-celery-beat` style dynamic scheduling (not applicable, this is FastAPI).
   - **Option B:** Use `celery.beat.Scheduler` subclass that reads from the database. The `celery-sqlalchemy-scheduler` or `celery-redbeat` packages support this.
   - **Option C:** Use `redbeat` (Redis-backed beat scheduler) -- already have Redis as broker. Best fit.
3. Remove `_background_scheduler()` thread and `_scheduler_wake` event.
4. Update settings endpoints to update the Celery Beat schedule when intervals change.
5. Add `celery beat` to the Docker Compose setup.

### Files Involved
- [backend/celery_app.py](backend/celery_app.py) - add beat configuration
- [backend/scan_engine.py](backend/scan_engine.py) - remove `_background_scheduler()`, `_dispatch_scheduled_scan()`, `_scheduler_wake`
- [backend/main.py](backend/main.py) - remove scheduler thread startup
- [backend/routers/settings.py](backend/routers/settings.py) or [backend/routers/scan_settings.py](backend/routers/scan_settings.py) - update schedules on setting change
- [docker-compose.yml](docker-compose.yml) - add celery-beat service
- [backend/requirements.txt](backend/requirements.txt) - add `celery-redbeat` or similar

### Complexity: Medium
- The core change is well-understood (Celery Beat is a standard pattern).
- The dynamic schedule from database is the tricky part -- `redbeat` handles this well with Redis.
- Need to ensure backward compatibility for deployments without Redis (current thread-based fallback).

### Dependencies
- **Soft dependency on item 4** (scan engine modularization). If modularization is done first, the scheduler code is already in its own module, making this cleaner. However, this can be done independently.
- Requires Redis (already a dependency for Celery broker).

### Risk Assessment
- **Medium risk.** The thread-based scheduler is battle-tested and simple. Celery Beat adds operational complexity (another process to manage). Need to keep the thread-based fallback for non-Redis deployments. The biggest risk is schedule drift or missed scans during migration.

---

## 6. Topology Endpoint Optimization (PC-1, PC-2)

### Current Implementation
- [topology.py](backend/routers/topology.py) uses a **version counter + cache** pattern:
  - `_topo_version`: integer counter in Redis (or in-memory fallback).
  - `_topo_cache`: stores the full serialized JSON body + ETag, keyed by version.
  - On `GET /api/topology`: if cache version matches current version AND client sends matching `If-None-Match` header, return 304.
  - Otherwise: query all devices, ports, links, racks, classes, models from DB, serialize, compute SHA-256 ETag from the body, cache it.
  - `_bump_topo_version()` called on position updates, meta updates, bulk updates.
- ETag is computed from the full response body SHA-256 hash (expensive: serialize everything, then hash).
- Cache TTL in Redis is 300 seconds.

### What Needs to Change
1. **Database-level change tracking:** Replace body-hash ETag with a database trigger or application-level tracking:
   - Add a `last_modified` timestamp column to relevant tables (Device, Port, TopologyLink, Rack), or
   - Use a single `topology_version` row in `AppSetting` that gets incremented on any topology-affecting write.
   - The version counter approach already exists (`_topo_version`), but it resets on restart unless Redis is available.
2. **Optimized ETag computation:**
   - Instead of hashing the entire response body, use the version counter directly as the ETag: `ETag: "v{topo_version}"`.
   - This eliminates the need to serialize + hash on every request when the cache is invalid.
3. **Incremental updates (future):**
   - The current approach sends the full topology on every change. A more advanced approach would support delta updates via WebSocket, but this is out of scope for this item.
4. **Ensure all mutation endpoints bump the version:**
   - Currently covered: device position, rack position, device meta, bulk meta.
   - Missing: scan completion (new devices/ports/links) -- the scan engine should bump `_topo_version` after persisting changes.

### Files Involved
- [backend/routers/topology.py](backend/routers/topology.py) - optimize ETag logic
- [backend/scan_engine.py](backend/scan_engine.py) - bump topo version after scan
- Potentially a new Alembic migration for `last_modified` columns (if going that route)

### Complexity: Small-Medium
- Using the version counter as ETag directly (instead of body hash) is a simple change.
- Ensuring all mutation paths bump the version requires auditing all write endpoints.

### Dependencies
- None. Independent of other items.

### Risk Assessment
- **Low risk.** The version counter pattern is already in place. The main change is ensuring completeness (all mutation paths bump the counter) and removing the expensive SHA-256 hash. The fallback behavior (full re-query on cache miss) is unchanged.

---

## 7. Loading/Error States in Settings Tabs

### Current Implementation

| Tab | Loading State | Error State | Notes |
|-----|--------------|-------------|-------|
| **ScanSettingsTab** | `settingsLoading` flag, shows nothing special while loading | `settingsError`, `rangesError` for specific sections | Has decent error handling |
| **CredentialsTab** | `loading` flag | `err` state variable | Shows errors inline, has loading state |
| **DnsTab** | `loading` flag | `err` state variable | Has both loading and error states |
| **MapSettingsTab** | No loading state | No error state | Purely presentational -- receives props from parent SettingsPage |
| **RacksTab** | `loading` flag | `err` state variable | Has both |
| **SnmpProfilesTab** | Receives `loading` prop from parent | `err` state variable | Loading delegated to parent |
| **SwitchClassesTab** | `loading` flag | `err` state variable | Has both |
| **SwitchModelsTab** | `loading` flag | `err` state variable | Has both |
| **ImportExportTab** | `configBusy` for operations | `configMsg` for both success/error | No initial loading state (no data to load) |

### What Needs to Change
1. **MapSettingsTab**: Receives all data as props from SettingsPage. The parent loads map settings with `.catch(() => {})` -- errors are silently swallowed. The parent should track loading/error state for map settings and pass them down.
2. **SettingsPage parent**: The map background and map settings loading (lines 33-42) uses `.catch(() => {})` which silently swallows errors. Should set error state.
3. **SnmpProfilesTab**: Loading state is from parent, but errors during profile loading in the parent are caught with `.catch(() => setProfLoading(false))` -- no error message shown.
4. All tabs use `String(ex)` for error display, which produces messages like `"Error: HTTP 500: Internal Server Error"` -- functional but not user-friendly.

### Files Involved
- [frontend/src/pages/SettingsPage.jsx](frontend/src/pages/SettingsPage.jsx) - add error handling for map settings/profile loading
- [frontend/src/components/settings/MapSettingsTab.jsx](frontend/src/components/settings/MapSettingsTab.jsx) - accept and display error/loading props
- Minor improvements to other tabs (optional)

### Complexity: Small
- Adding loading/error state is boilerplate React state management. The pattern already exists in most tabs.

### Dependencies
- Could be combined with item 8 (frontend error display consistency) for a unified approach.

### Risk Assessment
- **Very low risk.** UI-only changes. No backend modifications. Worst case is a cosmetic regression.

---

## 8. Frontend Error Display Consistency

### Current Implementation
Error handling patterns found across the frontend:

| Pattern | Files Using It |
|---------|---------------|
| `String(ex)` / `String(e)` | CredentialsTab, DnsTab, ImportExportTab, RacksTab, ScanSettingsTab, SnmpProfilesTab, SwitchClassesTab, SwitchModelsTab, DeviceTable |
| `e.message \|\| "fallback"` | LogsPage, LoginPage, DashboardPage |
| `.catch(() => {})` (silent) | SettingsPage (map bg, map settings) |
| `.catch(console.error)` | MapPage (position save), SettingsPage (map settings save) |

The `_checkOk()` function in api.js already extracts structured error messages (`body?.error?.message || body?.detail`), then wraps them in `Error()`. So `String(ex)` produces something like `"Error: HTTP 400: Username already exists"` -- the `"Error: "` prefix is redundant noise.

### What Needs to Change
1. Create a utility function `extractErrorMessage(ex)` in api.js or a shared utils file:
   ```js
   export function extractErrorMessage(ex) {
     if (ex instanceof Error) return ex.message;
     if (typeof ex === 'string') return ex;
     return 'An unexpected error occurred';
   }
   ```
2. Replace all `String(ex)` / `String(e)` calls with `extractErrorMessage(ex)`.
3. Replace silent `.catch(() => {})` with proper error state handling.
4. Create a shared `ErrorBanner` or `InlineError` component for consistent visual display (an `ErrorBoundary.jsx` already exists but is for React render errors, not API errors).

### Files Involved
- [frontend/src/api.js](frontend/src/api.js) - add `extractErrorMessage()` utility
- All 9 settings tab components - update error handling calls
- [frontend/src/components/DeviceTable.jsx](frontend/src/components/DeviceTable.jsx) - update error handling
- [frontend/src/pages/SettingsPage.jsx](frontend/src/pages/SettingsPage.jsx) - replace silent catches
- Optionally: new shared error display component

### Complexity: Small
- Mechanical find-and-replace across files. The `extractErrorMessage` utility is trivial.

### Dependencies
- Natural companion to item 7 (loading/error states). Should be done together or sequentially.

### Risk Assessment
- **Very low risk.** UI-only change. The `_checkOk()` function already normalizes API errors; this just cleans up how they are displayed.

---

## Summary Matrix

| # | Item | Complexity | Risk | Dependencies | Priority Recommendation |
|---|------|-----------|------|-------------|------------------------|
| 1 | WS ticket auth | Small | Low | None | High (security) |
| 2 | JWT refresh | Small | Low | None | High (UX) |
| 3 | Rate limiting | Small | Low | None | High (security, dry-run auth gap) |
| 4 | Scan engine modularization | Large | Medium-High | Before #5 | Medium (tech debt) |
| 5 | Celery Beat migration | Medium | Medium | Soft dep on #4 | Medium (operational) |
| 6 | Topology optimization | Small-Medium | Low | None | Medium (performance) |
| 7 | Settings loading/error states | Small | Very Low | Combine with #8 | Low (polish) |
| 8 | Error display consistency | Small | Very Low | Combine with #7 | Low (polish) |

### Recommended Implementation Order
1. **Item 3** (rate limiting) -- quick win, fixes the dry-run auth gap security issue
2. **Item 1** (WS ticket auth) -- small, immediate security improvement
3. **Item 2** (JWT refresh) -- small, leverages existing frontend utilities
4. **Items 7+8** together (frontend error consistency) -- small UI polish batch
5. **Item 6** (topology optimization) -- performance improvement
6. **Item 4** (scan engine modularization) -- large refactor, needs dedicated effort
7. **Item 5** (Celery Beat) -- after modularization for cleaner implementation
