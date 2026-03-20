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

- [x] **Centralized configuration module** -- Pydantic BaseSettings class in `config.py` covering all 15 env vars; 8 consumer files updated; fixes REDIS_URL default inconsistency (v1.15.0)
- [x] **Configurable log level** -- `LOG_LEVEL` env var support via BaseSettings; `logging.basicConfig` reads from config (v1.15.0)
- [x] **Session/token revocation** -- Redis-based JTI blacklist with `iat`/`jti` claims; `POST /api/auth/logout` + `POST /api/auth/revoke-all` (admin); user-level revocation (v1.15.0)
- [x] **Health check enhancements** -- `/health` checks DB (SELECT 1), Redis (PING), Celery (control.ping); returns `{status, checks}` with 503 on degraded (v1.15.0)

### Backend -- P2 (Medium Priority)

- [ ] **OpenTelemetry tracing** -- Add spans for run scan -> switch scan -> SNMP steps -> DB writes to troubleshoot performance bottlenecks
- [x] **Audit log retention policy** -- Configurable AUDIT_RETENTION_DAYS (default 90), Celery Beat cleanup every 6h, admin purge endpoint DELETE /api/audit-logs/purge (v1.15.0)
- [x] **Graceful shutdown handling** -- _shutdown_requested event in scheduler, shutdown_scheduler() called from lifespan cleanup, Celery worker_shutting_down signal handler (v1.15.0)
- [x] **Request/response logging middleware** -- Opt-in via REQUEST_LOG_ENABLED=true, logs method/path/status/duration_ms, skips /health /metrics /ws paths (v1.15.0)
- [ ] **API versioning strategy** -- Add version prefix to API endpoints to support backward-compatible evolution
- [ ] **SNMP v3 engine ID discovery** -- Add SNMPv3 engine ID auto-discovery for enterprise switches requiring explicit engine ID

### Frontend -- P1 (High Priority)

- [x] **TypeScript migration (store, hooks, pages)** -- Migrated store.ts, 4 hooks, 7 page files to TypeScript; shared types.ts with 11 interfaces (v1.15.0)
- [x] **Frontend component tests** -- 8 new tests: LoginPage (3), DashboardPage (3), DeviceTable (2); test-utils.tsx with renderWithRouter + API mocks (v1.15.0)
- [x] **Complete TypeScript migration** -- All 23 remaining .jsx/.js files migrated to TypeScript across 5 waves: styles, leaf components, settings tabs, core components, complex components + shell. Zero .jsx/.js files remain in src/ (v1.15.0)

### Frontend -- P2 (Medium Priority)

- [x] **Frontend lazy loading / code splitting** -- React.lazy() for 7 page components in main.tsx with Suspense loading spinner (v1.15.0)
- [x] **Notification/toast system** -- ToastProvider context with useToast hook, 4 toast types (success/error/warning/info), auto-dismiss 5s, stacked bottom-right, wired to scan start + import operations (v1.15.0)
- [ ] **Responsive/mobile layout** -- Fix fixed pixel widths and desktop-only layout in header nav and settings sidebar
- [ ] **Dark/light theme toggle** -- Add second token set and context-based theme switching (currently hardcoded dark theme)
- [x] **Keyboard shortcuts** -- useKeyboardShortcuts hook: digits 1-6 for page nav, Escape for blur/close, S for scan trigger; skips when inputs focused (v1.15.0)

### Testing / Quality -- P1 (High Priority)

- [x] **Expand backend test coverage** -- +35 new tests (97 total): topology router, settings router, health check, config module, token revocation, DNS module (9 tests), ping module (6 tests) (v1.15.0)
- [x] **Further backend test expansion** -- +116 tests (97->213): scanner plugins (49), db_helpers (9), rack/class/model CRUD (20), map background (11), audit logging (7), WebSocket (7), scan jobs (5), cascade delete (4), topology (4), settings (5) (v1.15.0)
- [x] **PostgreSQL-specific integration tests** -- SQLite FK enforcement via PRAGMA foreign_keys=ON; CASCADE delete + SET NULL verified for device->ports, scan_run->metrics, rack->device, class->device (v1.15.0)

### DevOps / Infrastructure -- P2 (Medium Priority)

- [x] **Environment-based configuration** -- Pydantic BaseSettings centralized config class with all env vars; configurable LOG_LEVEL. Remaining: feature flags (v1.15.0)
- [x] **Database backup/restore tooling** -- scripts/backup.sh (pg_dump via docker exec, gzipped), scripts/restore.sh (psql with confirmation), BACKUP.md documentation, backups/ in .gitignore (v1.15.0)

### Documentation -- P1 (High Priority)

- [x] **Update project-definition.md** -- Updated tech stack (PostgreSQL, Redis, Celery, TypeScript), architecture (6 Docker services), 9 features, 3 pages, 10 API groups, data persistence, dev setup (v1.14.0)

### Network Map & Access Control (Future)

- [ ] **Active VLAN Provisioning (MAC-based)** -- Automatically reconfigure switch ports to a specific VLAN when a known MAC address is detected during the frequent port scan
- [ ] **Endpoint Group Management** -- Group recognized end devices/clients and assign target VLANs to these groups for automated provisioning
- [ ] **802.1X / MAC Authentication Bypass (MAB) status** -- Show authentication state per port (authorized, unauthorized, guest VLAN)
- [ ] **Dynamic VLAN assignment visualization** -- Highlight ports where VLANs were dynamically assigned via RADIUS/NAC
- [ ] **Rogue device detection** -- Alert on unknown MAC addresses appearing on access ports that are not in the allowed endpoints list
- [ ] **Interactive port shutdown/bounce** -- Allow admins to administratively down or bounce a port directly from the map UI (requires write credentials)
- [ ] **Logical topology overlays** -- Toggle map views to show Spanning Tree (STP) root paths, blocked ports, or specific VLAN topologies