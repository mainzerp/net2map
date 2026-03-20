# TODO.md Update Analysis

**Date:** 2026-03-20
**Scope:** Full review of todo.md accuracy vs. current codebase state, plus identification of missing items.

---

## Table of Contents

1. [Current State of Each todo.md Item](#1-current-state-of-each-todomd-item)
2. [Items to Remove (Completed)](#2-items-to-remove-completed)
3. [Items Needing Description Updates](#3-items-needing-description-updates)
4. [Items That Are Accurate (Keep As-Is)](#4-items-that-are-accurate-keep-as-is)
5. [NEW Items Missing from todo.md](#5-new-items-missing-from-todomd)
6. [Project Definition Staleness](#6-project-definition-staleness)

---

## 1. Current State of Each todo.md Item

### UI / Frontend (all [x] -- ACCURATE)

| Item | Status | Notes |
|------|--------|-------|
| Class badge on rack detail panel | DONE | Confirmed in RackDetail.jsx / SwitchPanel.jsx |
| Class color on topology map nodes | DONE | TopologyMap.jsx color-codes by class |
| Rack / class filter on topology map | DONE | FilterBar.jsx exists |
| Settings: device overview tab | DONE | DevicesTab in SettingsPage NAV_GROUPS |

### Backend / Data (all [x] -- ACCURATE)

| Item | Status | Notes |
|------|--------|-------|
| Rack grouping via rack_id FK | DONE | topology.py uses rack_id FK |
| Profile ID on seeded credentials | DONE | seed_db.py assigns profile_id |

### Next Roadmap (High Impact)

| Item | Marked | Actual Status | Action |
|------|--------|---------------|--------|
| Role-based login for settings/actions | [ ] | PARTIALLY DONE | **NEEDS UPDATE** -- JWT RBAC with admin/operator/viewer roles exists (v1.7.0+, expanded v1.12.0-v1.13.0). Login page, user management, require_role decorators all implemented. The checkbox should be [x] with a note about what remains (e.g., per-setting granular permissions). |
| Scan queue + cancel support | [x] | DONE | Accurate |
| Historical scan runs | [x] | DONE | Accurate |
| Retry + timeout policy per profile | [x] | DONE | Accurate |

### Observability

| Item | Marked | Actual Status | Action |
|------|--------|---------------|--------|
| Structured JSON logging | [x] | DONE | Accurate |
| Prometheus metrics endpoint | [ ] | DONE | **SHOULD BE [x]** -- shared/metrics.py exists with 6 metrics (scan duration, scan total, active scans, device count, port count, request latency/total). MetricsMiddleware in main.py. /metrics endpoint implemented (v1.7.0). Authenticated since v1.12.0. |
| OpenTelemetry tracing | [ ] | NOT DONE | Accurate -- still open |

### Security / API Hardening (all [x] -- ACCURATE)

All 6 items correctly marked as done. Version annotations (v1.12.0, v1.13.0) are accurate.

### Product Improvements (all [x] -- ACCURATE)

All 3 items correctly marked as done.

### DevOps / Reliability

| Item | Marked | Actual Status | Action |
|------|--------|---------------|--------|
| Environment-based configuration matrix | [ ] | PARTIALLY DONE | **NEEDS UPDATE** -- docker-compose.yml uses env vars for DB/Redis/auth/encryption. .env.example exists. However, there is no centralized config module or feature flag system. The description should be refined. |

### Code Quality (all [x] -- ACCURATE)

All 7 items correctly marked as done with version annotations.

### Performance (all [x] -- ACCURATE)

Both items correctly marked as done with version annotations.

### Network Map & Access Control (Future)

| Item | Marked | Actual Status | Action |
|------|--------|---------------|--------|
| Active VLAN Provisioning | [ ] | NOT DONE | Accurate |
| Endpoint Group Management | [ ] | NOT DONE | Accurate |
| 802.1X / MAB status | [ ] | NOT DONE | Accurate |
| Dynamic VLAN assignment visualization | [ ] | NOT DONE | Accurate |
| Rogue device detection | [ ] | NOT DONE | Accurate |
| Interactive port shutdown/bounce | [ ] | NOT DONE | Accurate |
| Logical topology overlays | [ ] | NOT DONE | Accurate |
| Endpoint search & locate | [x] | DONE | Accurate |

---

## 2. Items to Remove (Completed)

These items are marked [ ] but are actually done and should be changed to [x]:

1. **Role-based login for settings/actions** -- JWT auth with RBAC (admin/operator/viewer), login page, user management, require_role decorators, rate-limited login, password complexity, token refresh -- all implemented across v1.7.0 through v1.13.0.

2. **Prometheus metrics endpoint** -- Full Prometheus instrumentation with 6 metrics, MetricsMiddleware, /metrics endpoint, scan instrumentation -- implemented in v1.7.0, auth-gated in v1.12.0.

---

## 3. Items Needing Description Updates

### Environment-based configuration matrix
- **Current description:** "Centralize runtime config via env vars (worker defaults, DNS fallback behavior, logging level, feature flags)"
- **Reality:** docker-compose.yml already uses env vars for all critical config (DB URL, Redis URL, JWT_SECRET, SECRET_TOKEN, ENCRYPTION_KEY, CORS_ORIGIN, DEFAULT_ADMIN_PASSWORD). .env.example documents all variables.
- **What remains:** No centralized Python config module (settings are scattered across module-level `os.getenv` calls). No feature flag system. No configurable logging level (hardcoded INFO). DNS fallback behavior is partially configurable via DB settings.
- **Suggested update:** Refine to focus on what's actually missing: centralized config class (e.g., Pydantic BaseSettings), configurable log levels, feature flags.

---

## 4. Items That Are Accurate (Keep As-Is)

Open items that are correctly described and still relevant:
- OpenTelemetry tracing
- Active VLAN Provisioning (MAC-based)
- Endpoint Group Management
- 802.1X / MAB status
- Dynamic VLAN assignment visualization
- Rogue device detection
- Interactive port shutdown/bounce
- Logical topology overlays

---

## 5. NEW Items Missing from todo.md

### Priority 1: High Impact / Low-Medium Effort

#### Testing & Quality

1. **Expand backend test coverage beyond ~43%** -- Current tests: 22 auth, 9 bulk, 8 config, 7 credentials, 12 schemas, 1 health = ~59 tests. Critical untested areas:
   - Scan engine (executor, scheduler, jobs, DNS, ping, db_helpers)
   - Topology endpoint logic
   - WebSocket communication
   - Scanner plugins (aruba_cx, fs, unifi, opnsense, generic)
   - Settings CRUD endpoints
   - Rack/class/model endpoints
   - Map background upload
   - Audit logging

2. **Frontend component tests** -- Only api.test.js utility tests exist. No component tests for any of the 20+ React components. Key candidates:
   - TopologyMap rendering
   - DeviceTable filtering/sorting
   - SwitchDetailSlideIn
   - Settings tab forms (validation, submit)
   - useScanProgress hook

3. **PostgreSQL-specific integration tests** -- Tests use SQLite in-memory with JSONB-to-JSON patching. Missing coverage for PostgreSQL-specific behavior: JSONB operators, CASCADE behavior, connection pooling, transaction isolation.

#### Documentation

4. **Project definition staleness** -- .github/instructions/project-definition.md is significantly outdated:
   - Lists "SQLite" as database but project uses PostgreSQL (since at least docker-compose setup)
   - Missing: Redis, Celery, Celery Beat from tech stack
   - Missing pages: Network, Devices (only lists Dashboard, Map, Logs, Settings)
   - Missing API groups: /api/auth, /api/audit, /api/users, /api/scan/jobs, /api/scan/dry-run, /api/stats, /api/switch-models, /ws/scan-progress
   - No mention of WebSocket support
   - Missing features: authentication/RBAC, tagged VLANs, dry-run, credential fallback, bulk device operations, endpoint search, Prometheus metrics, Celery task queue

#### TypeScript Migration

5. **Complete TypeScript migration for frontend** -- Only api.ts is migrated. All 20+ .jsx component and page files remain plain JavaScript. tsconfig.json is set up with strict mode. Prioritized candidates:
   - store.js (central state, complex types)
   - Hook files (useScanProgress, useTopologyData, useMapBackground, useRackOrders)
   - Page files (complex data shapes in DashboardPage, MapPage, SettingsPage)

### Priority 2: Medium Impact

#### Architecture

6. **Centralized configuration module** -- Replace scattered `os.getenv()` calls with a Pydantic BaseSettings class for type-safe, validated, documented configuration. Currently ~15 env vars are read ad-hoc across 6+ modules (main.py, database.py, celery_app.py, shared/auth.py, shared/crypto.py, shared/redis_client.py).

7. **Configurable log level** -- Logging is hardcoded to INFO (`logging.basicConfig(level=logging.INFO)`). No way to change log level without code modification. Should be configurable via env var (e.g., `LOG_LEVEL=DEBUG`).

8. **Frontend lazy loading / code splitting** -- All pages eagerly imported in App.jsx. As the app grows, React.lazy() with Suspense would improve initial load time. Low priority now but will matter with more pages.

#### Operational

9. **Database backup/restore tooling** -- No documented backup strategy for PostgreSQL data. The config export/import covers settings but not device history, scan runs, audit logs.

10. **Graceful shutdown handling** -- Celery workers and background scheduler need proper signal handling for graceful shutdown during deployments. The scheduler thread is a daemon thread that dies with the process, potentially mid-scan.

#### Security

11. **Session/token revocation** -- No token blacklist or session invalidation mechanism. Once a JWT is issued, it is valid until expiry (12h). If a user account is compromised, there is no way to revoke active tokens short of rotating JWT_SECRET (which invalidates ALL sessions).

12. **Audit log retention policy** -- Audit logs grow unbounded. No archival, rotation, or cleanup mechanism. For long-running deployments, the audit_log table will grow indefinitely.

### Priority 3: Lower Impact / Future

#### Frontend UX

13. **Dark/light theme toggle** -- Currently hardcoded dark theme. Design tokens (styles/tokens.js) exist but only define dark theme values. Adding a theme toggle would require a second token set and context-based switching.

14. **Keyboard shortcuts** -- No keyboard navigation for common actions (trigger scan, navigate between pages, open/close panels). Standard accessibility improvement.

15. **Notification system** -- No toast/notification system for async operations. Scan completion, import results, and error states rely on polling or page-level state. A global notification/toast system would improve UX for background operations.

16. **Responsive/mobile layout** -- UI uses fixed pixel widths and is designed for desktop. Header nav and settings page sidebar break on narrow viewports.

#### Backend

17. **API versioning** -- No API versioning strategy. All endpoints are under /api/ with no version prefix. As the API evolves, breaking changes affect all clients simultaneously.

18. **Request/response logging middleware** -- MetricsMiddleware tracks latency/counts but does not log request/response bodies for debugging. A configurable request logger (enabled via env var) would help troubleshoot API issues.

19. **Health check enhancements** -- /health endpoint returns simple 200 OK. Should check database connectivity, Redis connectivity, and Celery worker availability to provide meaningful health status for orchestrators.

20. **SNMP v3 engine ID discovery** -- No support for SNMPv3 engine ID auto-discovery. Some enterprise switches require explicit engine ID configuration for SNMPv3 authentication.

---

## 6. Project Definition Staleness

The file `.github/instructions/project-definition.md` requires significant updates:

| Section | Issue |
|---------|-------|
| Tech Stack | Lists SQLite; actual is PostgreSQL. Missing Redis, Celery, Celery Beat, prometheus-client, slowapi |
| Architecture | Describes SQLite file with Docker volume; actual is PostgreSQL service. Missing Redis, Celery worker, Celery Beat services |
| Key Features | Missing: Authentication/RBAC, Tagged VLANs, Dry-run scanning, Credential fallback chains, Bulk device operations, Endpoint search, Prometheus metrics, WebSocket scan progress, Audit logging |
| Frontend Pages | Missing: Network, Devices, Login pages |
| API | Missing 8+ endpoint groups: /api/auth, /api/audit, /api/users, /api/scan/jobs, /api/scan/dry-run, /api/stats, /api/switch-models, /ws/scan-progress |
| Data Persistence | Describes SQLite netmap.db; should describe PostgreSQL + Redis |
| Development Setup | Backend local setup doesn't mention Redis or Celery requirements |

---

## Summary

### Quick Stats
- **Items marked [ ] that are actually done:** 2 (Role-based login, Prometheus metrics)
- **Items needing description refinement:** 1 (Environment-based config)
- **Accurately marked completed items:** 25
- **Accurately marked open items:** 8
- **NEW items identified:** 20 (across 3 priority tiers)
- **Project definition sections needing update:** 7
