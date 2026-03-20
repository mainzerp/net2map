# TODO Update Implementation Plan

**Date:** 2026-03-20
**Source Analysis:** docs/SubAgent/TODO_UPDATE_ANALYSIS.md

---

## Checklist

### Phase 1: Rewrite todo.md

- [ ] Replace the entire content of `todo.md` with the new version below
- [ ] Verify all completed items have correct version tags
- [ ] Verify all open items are accurately described

### Phase 2: Update project-definition.md

- [ ] Update Tech Stack table (PostgreSQL, Redis, Celery, TypeScript)
- [ ] Update Architecture section (PostgreSQL, Redis, Celery worker, Celery Beat services)
- [ ] Update Key Features section (add authentication/RBAC, tagged VLANs, dry-run, credential fallback, bulk ops, endpoint search, Prometheus metrics, WebSocket scan progress, audit logging)
- [ ] Update Frontend Pages table (add Network, Devices, Login)
- [ ] Update API endpoint groups (add /api/auth, /api/audit, /api/users, /api/scan/jobs, /api/scan/dry-run, /api/stats, /api/switch-models, /ws/scan-progress)
- [ ] Update Data Persistence section (PostgreSQL + Redis)
- [ ] Update Development Setup (mention Redis and Celery requirements)

---

## Phase 1: Exact New Content for todo.md

The entire `todo.md` file should be replaced with the following content:

````markdown
# Switch-Map -- Open Items & Roadmap

## Completed

### UI / Frontend

- [x] **Class badge on rack detail panel** -- Show the assigned class name and color indicator on each switch in the rack side panel
- [x] **Class color on topology map nodes** -- Color-code switch nodes on the topology map by their class (Top of Rack = cyan, Access = green, Aggregation = amber, Core = purple)
- [x] **Rack / class filter on topology map** -- Add filter controls to show or hide devices by class or rack
- [x] **Settings: device overview tab** -- Add a "Devices" tab in settings showing all discovered devices with inline rack and class assignment columns

### Backend / Data

- [x] **Rack grouping via rack_id FK** -- Use the managed `rack_id` foreign key instead of (or alongside) the `location` string for rack grouping in the topology view
- [x] **Profile ID on seeded credentials** -- Assign `profile_id` to the seeded credentials so they correctly reference the global SNMP profiles

### Roadmap (High Impact)

- [x] **Role-based login for settings/actions** -- JWT RBAC with admin/operator/viewer roles, login page, user management, require_role decorators, rate-limited login, password complexity, token refresh (v1.7.0--v1.13.0)
- [x] **Scan queue + cancel support** -- Move scan execution to background jobs with status endpoint and cancel option to avoid blocked API requests during long scans
- [x] **Historical scan runs** -- Persist scan summaries and per-switch durations in DB to compare trends over time (slow switches, discovery drops, error spikes)
- [x] **Retry + timeout policy per profile** -- Add configurable retries/timeouts/concurrency limits on SNMP profile level for better control in mixed network environments

### Observability

- [x] **Structured JSON logging** -- Emit structured logs for scan start/end, per-device result, and DNS lookup outcomes with correlation/run ID
- [x] **Prometheus metrics endpoint** -- 6 metrics (scan duration, scan total, active scans, device count, port count, request latency/total), MetricsMiddleware, /metrics endpoint (v1.7.0, auth-gated v1.12.0)

### Security / API Hardening

- [x] **Rate limiting for heavy endpoints** -- Protect `/api/scan`, map uploads, and settings writes against abuse and accidental overload (v1.12.0: login 5/min, map upload 5/min via slowapi)
- [x] **Input validation hardening** -- Tighten validation for all settings endpoints (scan, DNS, map) and normalize error responses (v1.12.0: IP validation, password complexity min 8 chars)
- [x] **Credential secret protection** -- Encrypt SNMPv3 secrets at rest (key via env var) and redact sensitive fields in logs/responses (v1.12.0: bulk/config import encryption, community masking in exports)
- [x] **WebSocket ticket-based auth** -- Replace JWT token in WebSocket query string with short-lived single-use tickets to prevent token leakage in logs/history (v1.13.0)
- [x] **JWT token refresh mechanism** -- Add token refresh endpoint and frontend awareness for proactive session renewal before 12h expiry (v1.13.0)
- [x] **Rate limiting for scan + settings endpoints** -- Extend slowapi rate limiting to `/api/scan/trigger`, `/api/settings`, `/api/credentials` write endpoints (v1.13.0: dry-run 3/min, credentials/settings/users 10/min)

### Product Improvements

- [x] **Topology diff view between scans** -- Show newly discovered/removed devices and links after each run
- [x] **Bulk import/export for credentials/profiles** -- CSV/JSON import with validation and dry-run mode
- [x] **Per-port endpoint count + multi-host tooltip** -- Show number of learned MAC/IP per switch port and optional expanded list in detail view
- [x] **Endpoint search & locate** -- Global search bar to find a specific IP/MAC and highlight the exact switch and port it is connected to

### Code Quality (v1.12.0--v1.14.0)

- [x] **Scan engine modularization** -- Split scan_engine.py into 8-module package (broadcast, event_loop, ping, dns, db_helpers, executor, jobs, scheduler) with backward-compatible re-exports (v1.14.0)
- [x] **Celery Beat scheduler migration** -- scheduler_tick periodic Celery task with thread-based fallback for local dev; new celery-beat Docker service (v1.14.0)
- [x] **Scanner plugin discovery** -- __init_subclass__ with vendor_id= keyword and pkgutil auto-discovery; adding a scanner requires only one file (v1.14.0)
- [x] **Frontend CSS architecture** -- Design tokens (styles/tokens.js) and shared style objects (styles/shared.js) for centralized color, spacing, and component styles (v1.14.0)
- [x] **TypeScript migration (api layer)** -- tsconfig.json with strict mode, api.js -> api.ts with full type annotations, typecheck npm script (v1.14.0)
- [x] **Loading/error states in settings tabs** -- Add consistent loading spinners and error messages to MapSettingsTab and SnmpProfilesTab (v1.13.0)
- [x] **Frontend error display consistency** -- Standardize error message formatting via extractErrorMessage() utility across 9 components (v1.13.0)

### Performance (v1.12.0--v1.14.0)

- [x] **Topology endpoint optimization** -- Version-counter ETag replaces SHA-256 body hash; scan completion and credential CRUD now bump topology version (v1.13.0)
- [x] **N+1 query reduction in topology** -- Credential IP set replaced with SQL subquery in get_topology() and list_all_devices() (v1.14.0)

---

## Open Items

### Backend -- P1 (High Priority)

- [ ] **Centralized configuration module** -- Replace scattered `os.getenv()` calls (~15 env vars across 6+ modules) with a Pydantic BaseSettings class for type-safe, validated, documented configuration
- [ ] **Configurable log level** -- Logging is hardcoded to INFO; add env var support (e.g. `LOG_LEVEL=DEBUG`) to change log level without code modification
- [ ] **Session/token revocation** -- Add token blacklist or session invalidation mechanism; currently JWTs are valid until 12h expiry with no revocation path
- [ ] **Health check enhancements** -- Extend /health to verify database, Redis, and Celery worker connectivity for meaningful orchestrator health status

### Backend -- P2 (Medium Priority)

- [ ] **OpenTelemetry tracing** -- Add spans for run scan -> switch scan -> SNMP steps -> DB writes to troubleshoot performance bottlenecks
- [ ] **Audit log retention policy** -- Add archival, rotation, or cleanup for audit_log table which grows unbounded
- [ ] **Graceful shutdown handling** -- Add proper signal handling to Celery workers and background scheduler for clean shutdown during deployments
- [ ] **Request/response logging middleware** -- Add configurable request logger (enabled via env var) for API debugging beyond latency/count metrics
- [ ] **API versioning strategy** -- Add version prefix to API endpoints to support backward-compatible evolution
- [ ] **SNMP v3 engine ID discovery** -- Add SNMPv3 engine ID auto-discovery for enterprise switches requiring explicit engine ID

### Frontend -- P1 (High Priority)

- [ ] **Complete TypeScript migration** -- Migrate remaining 20+ .jsx component/page files to TypeScript (tsconfig.json already configured with strict mode). Priority: store.js, hooks, page files
- [ ] **Frontend component tests** -- Add component tests (currently only api.test.js utility tests exist). Key targets: TopologyMap, DeviceTable, SwitchDetailSlideIn, settings tab forms, useScanProgress hook

### Frontend -- P2 (Medium Priority)

- [ ] **Frontend lazy loading / code splitting** -- Add React.lazy() with Suspense for page components to improve initial load time
- [ ] **Notification/toast system** -- Add global notification system for async operations (scan completion, import results, error states) beyond polling/page-level state
- [ ] **Responsive/mobile layout** -- Fix fixed pixel widths and desktop-only layout in header nav and settings sidebar
- [ ] **Dark/light theme toggle** -- Add second token set and context-based theme switching (currently hardcoded dark theme)
- [ ] **Keyboard shortcuts** -- Add keyboard navigation for common actions (trigger scan, page navigation, panel open/close)

### Testing / Quality -- P1 (High Priority)

- [ ] **Expand backend test coverage beyond ~43%** -- Critical untested areas: scan engine (executor, scheduler, jobs, DNS, ping, db_helpers), topology endpoints, WebSocket, scanner plugins, settings/rack/class/model CRUD, map background upload, audit logging
- [ ] **PostgreSQL-specific integration tests** -- Tests currently use SQLite in-memory with JSONB-to-JSON patching; missing coverage for JSONB operators, CASCADE behavior, connection pooling, transaction isolation

### DevOps / Infrastructure -- P2 (Medium Priority)

- [ ] **Environment-based configuration** -- docker-compose.yml uses env vars for critical config and .env.example exists; still missing: centralized Python config class, configurable log levels, feature flags
- [ ] **Database backup/restore tooling** -- No documented backup strategy for PostgreSQL data; config export/import covers settings but not device history, scan runs, audit logs

### Documentation -- P1 (High Priority)

- [ ] **Update project-definition.md** -- File is significantly outdated: lists SQLite (actual: PostgreSQL), missing Redis/Celery/Celery Beat from stack, missing pages (Network, Devices, Login), missing 8+ API groups, no mention of WebSocket, missing major features (auth/RBAC, tagged VLANs, dry-run, credential fallback, bulk ops, Prometheus)

### Network Map & Access Control (Future)

- [ ] **Active VLAN Provisioning (MAC-based)** -- Automatically reconfigure switch ports to a specific VLAN when a known MAC address is detected during the frequent port scan
- [ ] **Endpoint Group Management** -- Group recognized end devices/clients and assign target VLANs to these groups for automated provisioning
- [ ] **802.1X / MAC Authentication Bypass (MAB) status** -- Show authentication state per port (authorized, unauthorized, guest VLAN)
- [ ] **Dynamic VLAN assignment visualization** -- Highlight ports where VLANs were dynamically assigned via RADIUS/NAC
- [ ] **Rogue device detection** -- Alert on unknown MAC addresses appearing on access ports that are not in the allowed endpoints list
- [ ] **Interactive port shutdown/bounce** -- Allow admins to administratively down or bounce a port directly from the map UI (requires write credentials)
- [ ] **Logical topology overlays** -- Toggle map views to show Spanning Tree (STP) root paths, blocked ports, or specific VLAN topologies
````

### Key Changes from Current todo.md

1. **Role-based login**: Changed from `[ ]` to `[x]` with version tags (v1.7.0--v1.13.0)
2. **Prometheus metrics endpoint**: Changed from `[ ]` to `[x]` with version tags (v1.7.0, auth-gated v1.12.0)
3. **Environment-based configuration matrix**: Moved to open items with refined description reflecting partial completion (env vars exist, but no centralized config class, configurable log levels, or feature flags)
4. **Endpoint search & locate**: Moved from Future section to Completed (was already `[x]`)
5. **TypeScript migration**: Renamed to "TypeScript migration (api layer)" since only api.ts is done
6. **20 new items added** organized into Backend P1/P2, Frontend P1/P2, Testing/Quality P1, DevOps/Infra P2, Documentation P1, and Future sections
7. **Document restructured** into Completed (top) and Open Items (bottom) with priority groupings

---

## Phase 2: Key Changes for project-definition.md

The following sections of `.github/instructions/project-definition.md` need updating:

### 2.1 Tech Stack Table

Replace:

```markdown
| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, SQLAlchemy, Pydantic, PySNMP |
| Database | SQLite (via SQLAlchemy ORM, WAL mode) |
| Frontend | React 18, React Router v6, Vite |
| Serving | Nginx (static assets + reverse proxy to backend) |
| Deployment | Docker, Docker Compose |
```

With:

```markdown
| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, SQLAlchemy, Pydantic, PySNMP, Celery |
| Database | PostgreSQL 16 (via SQLAlchemy ORM, connection pooling) |
| Cache / Broker | Redis (Celery broker, WebSocket tickets, session data) |
| Task Queue | Celery worker + Celery Beat (periodic scan scheduling) |
| Frontend | React 18, React Router v6, Vite, TypeScript (partial) |
| Monitoring | prometheus-client (6 metrics, /metrics endpoint) |
| Serving | Nginx (static assets + reverse proxy to backend) |
| Deployment | Docker, Docker Compose (6 services) |
```

### 2.2 Architecture Section

Replace the entire Architecture section with content reflecting:
- `backend/` -- FastAPI + SQLAlchemy with PostgreSQL, Alembic migrations
- `frontend/` -- React SPA with Vite, TypeScript (api.ts), Nginx reverse proxy
- `celery worker` -- Background scan execution, dry-run jobs
- `celery-beat` -- Periodic scan scheduling via `scheduler_tick` task
- `redis` -- Celery broker, WebSocket ticket store, general caching
- `postgres` -- Primary data store with connection pooling
- `docker-compose.yml` -- Defines 6 services: netmap-backend, netmap-frontend, netmap-celery, celery-beat, redis, postgres

### 2.3 Key Features Section

Add these missing features to the existing list:
- **Authentication / RBAC** -- JWT-based auth with admin/operator/viewer roles, login page, user management
- **Tagged VLAN Collection** -- Q-BRIDGE-MIB bitmask parsing for tagged VLAN memberships per port
- **Dry-Run Scanning** -- Preview scan results before committing to database
- **Credential Fallback Chains** -- Priority-ordered credentials per IP with automatic fallback
- **Bulk Device Operations** -- Multi-select ignore/re-enable from device table
- **Endpoint Search & Locate** -- Global IP/MAC search highlighting exact switch and port
- **Prometheus Metrics** -- 6 metrics with MetricsMiddleware and authenticated /metrics endpoint
- **WebSocket Scan Progress** -- Real-time scan status updates via ticket-authenticated WebSocket
- **Audit Logging** -- Persistent audit trail for security-sensitive operations

### 2.4 Frontend Pages Table

Replace:

```markdown
| Page | Description |
|---|---|
| Dashboard | Overview of discovered devices and recent scan status |
| Map | Interactive topology map with draggable device nodes and LLDP links |
| Logs | Live log feed from the backend |
| Settings | SNMP credentials/profiles, scan settings, DNS settings, rack and switch class management |
```

With:

```markdown
| Page | Description |
|---|---|
| Login | Authentication page with JWT login form |
| Dashboard | Overview of discovered devices, scan status, and network statistics |
| Map | Interactive topology map with draggable device nodes, LLDP links, rack detail slide-in, and endpoint search |
| Network | Network-level views and VLAN information |
| Devices | Device listing with bulk operations, ignore/re-enable, and metadata editing |
| Logs | Live log feed from the backend |
| Settings | SNMP credentials/profiles, scan settings, DNS settings, rack and switch class management, user management |
```

### 2.5 API Section

Add these endpoint groups to the existing list:

```markdown
- `/api/auth` -- Login, logout, token refresh, WebSocket ticket exchange
- `/api/users` -- User CRUD with role management (admin only)
- `/api/audit` -- Audit log retrieval
- `/api/scan/jobs` -- Background scan job management
- `/api/scan/dry-run` -- Dry-run scan preview
- `/api/stats` -- Network statistics
- `/api/switch-models` -- Switch model management
- `/api/health` -- Health check endpoint
- `/metrics` -- Prometheus metrics (authenticated)
- `/ws/scan-progress` -- WebSocket for real-time scan progress (ticket-authenticated)
```

### 2.6 Data Persistence Section

Replace the SQLite paragraph with:

```markdown
Primary data is stored in PostgreSQL 16 with connection pooling (pool_size=10, max_overflow=20). Schema migrations are managed by Alembic. Redis is used as the Celery task broker, for WebSocket ticket storage (30s TTL), and as a general cache. Data volumes: `netmap-pgdata` (PostgreSQL) and `netmap-redis` (Redis).
```

### 2.7 Development Setup -- Local Section

Update backend local setup to include:

```markdown
# Backend
cd backend
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
# Requires: PostgreSQL and Redis running locally
# Set DATABASE_URL, REDIS_URL env vars
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Celery worker (separate terminal)
celery -A celery_app worker --loglevel=info

# Celery Beat (separate terminal, optional)
celery -A celery_app beat --loglevel=info
```

---

## Summary

This plan covers two files:

1. **todo.md** -- Complete rewrite that:
   - Marks 2 falsely-open items as completed with version tags
   - Moves "Endpoint search & locate" from Future to Completed
   - Refines the environment config item description for partial completion
   - Adds 20 new items across 3 priority tiers
   - Reorganizes into Completed (top) and Open Items (bottom) with logical groupings: Backend P1/P2, Frontend P1/P2, Testing/Quality P1, DevOps/Infra P2, Documentation P1, Future

2. **project-definition.md** -- 7 section updates to reflect current reality:
   - PostgreSQL instead of SQLite
   - Redis + Celery + Celery Beat in stack
   - TypeScript (partial) in frontend
   - 6 Docker services instead of 2
   - All pages and API groups documented
   - Authentication/RBAC and 8 other major features added
