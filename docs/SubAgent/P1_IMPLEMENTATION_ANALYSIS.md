# P1 Implementation Analysis

Research and feasibility analysis for all P1 (High Priority) items from `todo.md`.

---

## 1. Centralized Configuration Module (Pydantic BaseSettings)

### Current State

Environment variables are scattered across 8+ files with `os.getenv()` / `os.environ.get()` calls. Some variables are read in multiple places with inconsistent defaults.

### Complete Inventory of os.getenv / os.environ Calls

| File | Line | Env Var | Default | Type | Notes |
|------|------|---------|---------|------|-------|
| `main.py` | 31 | `CORS_ORIGIN` | `"http://localhost:3000"` | str | Used for CORS middleware |
| `main.py` | 49 | `JWT_SECRET` | (none) | str | Startup check only |
| `main.py` | 49 | `SECRET_TOKEN` | (none) | str | Startup check only |
| `main.py` | 55 | `ENCRYPTION_KEY` | (none) | str | Startup check only |
| `database.py` | 11 | `DATABASE_URL` | `"postgresql://netmap:netmap_pw@postgres/netmap"` | str | SQLAlchemy connection string |
| `celery_app.py` | 6 | `REDIS_URL` | `"redis://localhost:6379/0"` | str | Celery broker+backend URL |
| `shared/auth.py` | 13 | `JWT_SECRET` | fallback to `SECRET_TOKEN`, then `""` | str | JWT signing key |
| `shared/auth.py` | 15 | `JWT_EXPIRY_HOURS` | `"24"` | int (via str) | Token expiry duration |
| `shared/auth.py` | 18 | `SECRET_TOKEN` | `""` | str | Legacy single-token auth |
| `shared/crypto.py` | 5 | `ENCRYPTION_KEY` | `""` | str | Fernet encryption key |
| `shared/redis_client.py` | 5 | `REDIS_URL` | `""` | str | **Different default** than celery_app.py! |
| `routers/ws.py` | 79 | `JWT_SECRET` | fallback to `SECRET_TOKEN`, then `""` | str | Duplicated auth logic in WS handler |
| `routers/ws.py` | 80 | `SECRET_TOKEN` | `""` | str | Duplicated auth logic in WS handler |
| `alembic/env.py` | 16 | `DATABASE_URL` | (none, raises RuntimeError) | str | Migration DB URL |
| `alembic/versions/006_...` | 31 | `DEFAULT_ADMIN_PASSWORD` | `"changeme"` | str | One-time migration seed |

### Issues Found

1. **REDIS_URL inconsistency**: `celery_app.py` defaults to `"redis://localhost:6379/0"` while `shared/redis_client.py` defaults to `""`. This means Celery always tries to connect to Redis even when not configured, but the Redis client module gracefully returns None.
2. **JWT_SECRET duplication**: `shared/auth.py` and `routers/ws.py` both independently read `JWT_SECRET`/`SECRET_TOKEN`. If auth module evolves, the WS handler becomes stale.
3. **No type validation**: `JWT_EXPIRY_HOURS` is cast to `int()` at module level with no error handling -- a non-numeric value causes a startup crash with an unhelpful error.
4. **No centralized documentation**: Environment variables are only discoverable by reading source code.

### Recommended Implementation

Create `backend/config.py` with Pydantic `BaseSettings`:

```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str = "postgresql://netmap:netmap_pw@postgres/netmap"
    redis_url: str = ""
    cors_origin: str = "http://localhost:3000"
    jwt_secret: str = ""
    secret_token: str = ""  # legacy
    jwt_expiry_hours: int = 24
    encryption_key: str = ""
    default_admin_password: str = "changeme"
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

settings = Settings()
```

### Effort Estimate

- **Complexity**: Medium
- **Files to modify**: 8 (main.py, database.py, celery_app.py, shared/auth.py, shared/crypto.py, shared/redis_client.py, routers/ws.py, alembic/env.py)
- **New files**: 1 (backend/config.py)
- **New dependency**: `pydantic-settings` (add to requirements.txt)
- **Risk**: Low -- all changes are mechanical `os.getenv()` -> `settings.xxx` replacements
- **Testing**: Existing tests should pass since conftest.py sets env vars before import, which Pydantic BaseSettings will still read

---

## 2. Configurable Log Level via Env Var

### Current State

- Single `logging.basicConfig()` call in `main.py` line 28, hardcoded to `level=logging.INFO`
- 13 modules use `logging.getLogger(__name__)` (properly namespaced)
- No way to change log level without code modification
- Celery workers and background tasks inherit this level

### Affected Logging Locations

| Module | Logger |
|--------|--------|
| `main.py` | `__main__` (via basicConfig) |
| `scan_engine/executor.py` | `scan_engine.executor` |
| `scan_engine/db_helpers.py` | `scan_engine.db_helpers` |
| `scan_engine.py` (legacy) | `scan_engine` |
| `snmp_scanner.py` | `snmp_scanner` |
| `routers/ws.py` | `routers.ws` |
| `shared/file_settings.py` | `shared.file_settings` |
| `shared/auth.py` | `shared.auth` |
| `shared/crypto.py` | `shared.crypto` |
| `shared/redis_client.py` | `shared.redis_client` |
| `shared/state.py` | `shared.state` |
| `shared/audit.py` | `shared.audit` |

### Recommended Implementation

Minimal change in `main.py`:

```python
log_level = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, log_level, logging.INFO), ...)
```

Or, if combined with P1 item #1 (centralized config):

```python
logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO), ...)
```

### Effort Estimate

- **Complexity**: Trivial
- **Files to modify**: 1 (main.py, line 28)
- **Risk**: None
- **Dependency**: Standalone or can combine with centralized config module
- **Note**: Should be done together with #1 if centralized config is implemented first

---

## 3. Session/Token Revocation Mechanism

### Current State

- JWT tokens are created in `shared/auth.py:create_token()` with configurable expiry (default 24h)
- Token validation in `_require_auth()` only checks signature and expiry -- no blacklist check
- Token refresh in `routers/auth.py:refresh_token()` issues new tokens but does not invalidate old ones
- WebSocket uses short-lived tickets (30s TTL in Redis) which is already good
- No logout endpoint that invalidates the token
- If a user is deactivated or their role changes, existing tokens remain valid until expiry

### Auth Flow Analysis

```
Login -> create_token(user_id, username, role) -> JWT with exp claim
                                                    |
                                              _require_auth()
                                                    |
                                           jwt.decode() -> check exp only
                                                    |
                                           No blacklist/revocation check
```

### Revocation Options

**Option A: Redis-based token blacklist (Recommended)**
- Store revoked JTI (JWT ID) in Redis with TTL matching token expiry
- On logout/user deactivation/password change, add token's JTI to blacklist
- Modify `_require_auth()` to check blacklist before allowing access
- Pros: Fast O(1) lookup, auto-cleanup via TTL, no DB load
- Cons: Requires Redis (already in stack)
- **Complexity**: Medium

**Option B: Database version counter**
- Add `token_version` column to User table
- Include version in JWT payload
- On logout/password change, increment version
- Validate version in `_require_auth()`
- Pros: No Redis dependency
- Cons: DB query on every request (but user lookup could be cached)
- **Complexity**: Medium

### Recommended Implementation (Option A)

1. Add `jti` (unique ID) to JWT payload in `create_token()`
2. Add `POST /api/auth/logout` endpoint that blacklists current token's JTI in Redis
3. Modify `_require_auth()` to check Redis blacklist: `ws_blacklist:{jti}` with TTL = remaining token life
4. On user deactivation/password change, blacklist all active tokens for that user (requires tracking or using user-scoped prefix)

### Files to Modify

- `shared/auth.py` -- add JTI to payload, add blacklist check in `_require_auth()`
- `routers/auth.py` -- add `/api/auth/logout` endpoint, modify user update to revoke tokens
- `shared/redis_client.py` -- no changes needed (already provides `get_redis()`)

### Effort Estimate

- **Complexity**: Medium
- **Files to modify**: 2 (shared/auth.py, routers/auth.py)
- **New migration**: 0 (Redis-only, no schema change)
- **Risk**: Medium -- must handle Redis unavailability gracefully (skip blacklist check if Redis down, matching existing pattern)
- **Frontend impact**: Need to add logout API call (currently only clears localStorage)

---

## 4. Health Check Enhancements

### Current State

The health endpoint in `routers/health.py` is 6 lines:

```python
@router.get("/health", include_in_schema=False)
def health():
    return {"status": "ok"}
```

This always returns 200 OK regardless of actual system health. Docker/orchestrator health checks see "healthy" even when the database is down or Redis is unreachable.

### What to Add

| Check | How | Import/Dependency |
|-------|-----|-------------------|
| **Database** | `SELECT 1` via `get_db()` session | `database.get_db` (already in the project) |
| **Redis** | `redis.ping()` via `get_redis()` | `shared.redis_client.get_redis` (already exists) |
| **Celery** | `celery_app.control.ping(timeout=2)` or check Redis key | `celery_app.celery_app` |

### Recommended Implementation

```python
@router.get("/health", include_in_schema=False)
def health():
    checks = {}
    overall = "ok"

    # Database
    try:
        db = next(get_db())
        db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as e:
        checks["database"] = f"error: {e}"
        overall = "degraded"

    # Redis
    r = get_redis()
    if r:
        try:
            r.ping()
            checks["redis"] = "ok"
        except Exception as e:
            checks["redis"] = f"error: {e}"
            overall = "degraded"
    else:
        checks["redis"] = "not_configured"

    # Celery (optional -- check via Redis key or control.ping)
    if r:
        try:
            from celery_app import celery_app
            result = celery_app.control.ping(timeout=2)
            checks["celery"] = "ok" if result else "no_workers"
        except Exception:
            checks["celery"] = "unreachable"
            overall = "degraded"

    return {"status": overall, "checks": checks}
```

### Effort Estimate

- **Complexity**: Low
- **Files to modify**: 1 (routers/health.py)
- **Risk**: Low -- must ensure health check itself does not cause cascading failures (short timeouts, no retries)
- **Consideration**: Health endpoint is in `_AUTH_EXEMPT_PATHS` so no auth needed (correct for load balancer probes)
- **Existing test**: `test_health.py` needs update to verify new response structure

---

## 5. Complete TypeScript Migration (Frontend)

### Current State

- `tsconfig.json` is configured with `strict: true`, `allowJs: true`, `checkJs: false`
- `api.ts` is the only TypeScript file (fully typed)
- `@types/react` and `@types/react-dom` are in devDependencies
- `typecheck` npm script exists: `tsc --noEmit`
- 28 .jsx files + 4 .js hook files + 2 .js style files + 1 .js store file = **35 files** to migrate

### File Inventory by Complexity

**High complexity (300+ lines) -- 6 files:**

| File | Lines | Key Challenges |
|------|-------|----------------|
| `components/settings/ScanSettingsTab.jsx` | 668 | Complex form state, multiple settings sections, interval parsing |
| `components/map/RackDetail.jsx` | 586 | SVG rendering, drag/drop, device positioning |
| `components/DeviceTable.jsx` | 586 | Table sorting, filtering, inline editing, navigation |
| `components/settings/CredentialsTab.jsx` | 454 | CRUD forms, profile associations, fallback chains |
| `components/map/TopologyMap.jsx` | 440 | SVG zoom/pan, node positioning, link rendering, click handlers |
| `pages/DashboardPage.jsx` | 346 | Multiple data fetches, summary cards, scan status |

**Medium complexity (100-299 lines) -- 15 files:**

| File | Lines | Key Challenges |
|------|-------|----------------|
| `pages/MapPage.jsx` | 279 | Layout composition, filter state, rack selection |
| `components/SwitchDetailSlideIn.jsx` | 241 | Port table, link mapping, sort state |
| `components/settings/SwitchModelsTab.jsx` | 232 | CRUD form, model parameters |
| `pages/SettingsPage.jsx` | 231 | Tab routing, 9 child tab components |
| `components/settings/SnmpProfilesTab.jsx` | 208 | v2c/v3 form switching, credential profiles |
| `components/settings/SwitchClassesTab.jsx` | 201 | CRUD form, color picker |
| `components/Port.jsx` | 188 | SVG port rendering, status colors, tooltips |
| `components/settings/RacksTab.jsx` | 176 | CRUD form, map coordinates |
| `components/SwitchPanel.jsx` | 161 | Port grid layout, interactive ports |
| `components/PortDetailModal.jsx` | 144 | Modal dialog, endpoint details |
| `pages/LogsPage.jsx` | 137 | Log list, filtering, auto-scroll |
| `pages/LoginPage.jsx` | 136 | Login form, validation, token storage |
| `App.jsx` | 116 | Router setup, auth guard, layout |
| `store.js` | 111 | Zustand store, all app state+actions |
| `components/settings/MapSettingsTab.jsx` | 90 | Simple form, file upload |

**Low complexity (<100 lines) -- 14 files:**

| File | Lines | Key Challenges |
|------|-------|----------------|
| `components/settings/DnsTab.jsx` | 88 | Simple DNS server list form |
| `components/map/FilterBar.jsx` | 84 | Checkbox filters |
| `styles/shared.js` | 70 | Style objects (pure data, no JSX) |
| `hooks/useScanProgress.js` | 64 | WebSocket hook, single custom hook |
| `components/settings/ImportExportTab.jsx` | 64 | File upload/download buttons |
| `styles/tokens.js` | 61 | Design token constants (pure data) |
| `hooks/useRackOrders.js` | 55 | LocalStorage-backed state |
| `components/ErrorBoundary.jsx` | 39 | React error boundary class component |
| `main.jsx` | 29 | App entry point, StrictMode wrapper |
| `components/map/ActiveLinkBar.jsx` | 26 | Simple status bar component |
| `hooks/useTopologyData.js` | 19 | Thin wrapper hook |
| `hooks/useMapBackground.js` | 19 | Thin wrapper hook |
| `pages/NetworkPage.jsx` | 13 | Thin page wrapper |
| `pages/DevicesPage.jsx` | 13 | Thin page wrapper |

### Migration Strategy

1. **Phase 1 -- Pure data files** (styles/tokens.js, styles/shared.js): Trivial rename, add type annotations to exports
2. **Phase 2 -- Store + hooks** (store.js, 4 hooks): Define state/action types, type the Zustand store
3. **Phase 3 -- Simple pages/components** (14 low-complexity files): Props interfaces, rename to .tsx
4. **Phase 4 -- Medium components** (15 files): Prop types, event handler types, API response types
5. **Phase 5 -- Complex components** (6 files): Full typing of complex state, SVG event types, form state

### Prerequisites

- Define shared TypeScript interfaces for API response types (topology nodes, links, devices, settings, etc.)
- These types should live in a `types.ts` or `types/` directory
- The existing `api.ts` can be extended with response type generics

### Effort Estimate

- **Complexity**: High (volume of work, not technical difficulty)
- **Total files**: 35
- **Estimated per-file effort**: 15-60 minutes depending on complexity
- **Risk**: Low -- `allowJs: true` means gradual migration works; files can be converted one at a time
- **No runtime changes** -- TypeScript is compile-time only

---

## 6. Frontend Component Tests

### Current Test Setup

- **Test runner**: Vitest 1.6.0 with jsdom environment
- **Config**: `vitest.config.js` -- `globals: true`, `environment: "jsdom"`, React plugin
- **Dependencies**: `@testing-library/react` 14.3.0 already installed
- **Existing tests**: 1 file (`__tests__/api.test.js`) with 3 pure utility tests (speedLabel, normPort, buildPortLinkMap)
- **Test scripts**: `npm test` (vitest run), `npm run test:watch` (vitest)
- **No component tests exist yet**

### Key Components That Need Tests

**Critical (core user-facing functionality):**

| Component | Why | Test Focus |
|-----------|-----|-----------|
| `LoginPage` | Auth entry point | Form submission, validation, error display, token storage |
| `DeviceTable` | Primary data view | Sorting, filtering, row rendering, navigation |
| `TopologyMap` | Core visualization | Node/link rendering, click handlers, zoom (SVG snapshot) |
| `SwitchDetailSlideIn` | Device detail view | Port table rendering, sort, link display |
| `DashboardPage` | Landing page | Data fetch, summary cards, scan trigger |

**Important (settings/configuration):**

| Component | Why | Test Focus |
|-----------|-----|-----------|
| `CredentialsTab` | CRUD operations | Create/edit/delete forms, validation, API calls |
| `ScanSettingsTab` | Complex form | Settings save, interval parsing, validation |
| `SnmpProfilesTab` | v2c/v3 switching | Form mode switching, field visibility |
| `ImportExportTab` | Data I/O | File upload, download trigger |

**Hooks:**

| Hook | Test Focus |
|------|-----------|
| `useScanProgress` | WebSocket connection, message handling, reconnect |
| `useTopologyData` | Data fetching, store integration |

### Test Infrastructure Needs

1. **API mocking**: Mock `api.ts` fetch calls for component tests (vi.mock or MSW)
2. **Router context**: Components using `useNavigate` need `MemoryRouter` wrapper
3. **Store setup**: Zustand store needs test initialization helper
4. **Render helper**: Wrapper component providing Router + Store context

### Effort Estimate

- **Complexity**: Medium-High
- **Test infrastructure setup**: 1 file (test utilities/render helpers)
- **Per-component**: 1-3 hours depending on complexity
- **Priority targets**: LoginPage, DeviceTable, DashboardPage (highest user impact)
- **Risk**: Low -- testing library already installed, just needs tests written

---

## 7. Expand Backend Test Coverage Beyond ~43%

### Current Test Coverage

**6 test files** with **468 total lines** of test code:

| Test File | Lines | Module Tested | Coverage |
|-----------|-------|---------------|----------|
| `test_auth.py` | 186 | `routers/auth.py`, `shared/auth.py` | Good -- login, JWT, roles, refresh, user CRUD |
| `test_config.py` | 130 | `routers/config.py` | Good -- export/import, dry-run, masking |
| `test_bulk.py` | 128 | `routers/bulk.py` | Good -- export/import credentials, masking |
| `test_schemas.py` | 66 | `schemas.py` | Good -- validation, clamping, defaults |
| `test_credentials.py` | 42 | `routers/credentials.py` | Good -- CRUD operations |
| `test_health.py` | 6 | `routers/health.py` | Minimal -- just status check |

### Critical Untested Modules

**Tier 1 -- Scan Engine (highest risk, most complex code):**

| Module | Lines | Why Critical |
|--------|-------|-------------|
| `scan_engine/executor.py` | 765 | Core scan logic, credential fallback, range expansion, rate limiting |
| `snmp_scanner.py` | 742 | SNMP communication, data parsing, model extraction |
| `scan_engine/scheduler.py` | 98 | Background scheduling, lock management, dispatch logic |
| `scan_engine/jobs.py` | 81 | Scan job lifecycle, cancel handling |
| `scan_engine/dns.py` | 90 | DNS resolution, caching, custom nameservers |
| `scan_engine/ping.py` | 41 | ICMP ping, cross-platform command building |
| `scan_engine/db_helpers.py` | 78 | Range expansion, link key normalization, scan run persistence |
| `scan_engine/broadcast.py` | 29 | WebSocket broadcast to connected clients |

**Tier 2 -- Untested Router Endpoints:**

| Module | Lines | Why Critical |
|--------|-------|-------------|
| `routers/topology.py` | 260 | Primary data endpoint, ETag, device grouping |
| `routers/scan.py` | 62 | Scan trigger, job status, cancel |
| `routers/scan_runs.py` | 57 | Scan history queries |
| `routers/scan_settings.py` | 79 | Scan/DNS/map settings CRUD |
| `routers/settings.py` | 46 | App settings read/write |
| `routers/ws.py` | 88 | WebSocket authentication and broadcasting |
| `routers/map_bg.py` | 89 | File upload/download, image validation |
| `routers/racks.py` | 46 | Rack CRUD |
| `routers/switch_classes.py` | 62 | Switch class CRUD |
| `routers/switch_models.py` | 46 | Switch model CRUD |
| `routers/snmp_profiles.py` | 58 | SNMP profile CRUD |
| `routers/audit.py` | 14 | Audit log query |
| `routers/logs.py` | 8 | Log retrieval |

**Tier 3 -- Shared Modules:**

| Module | Lines | Why Critical |
|--------|-------|-------------|
| `shared/state.py` | 346 | Scan state management, Redis/in-memory state, distributed locks |
| `shared/file_settings.py` | 127 | Settings read/write, normalization, validation |
| `shared/audit.py` | 31 | Audit logging |
| `tasks.py` | 100 | Celery task execution, retry logic |
| `shared/crypto.py` | 26 | Encryption/decryption |

### Test Infrastructure Notes

- Current conftest.py patches JSONB->JSON for SQLite compatibility
- Mocks `pysnmp`, `snmp_scanner`, and `scan_engine` modules entirely
- To test scan engine, either: (a) unmock and test with real module but mock SNMP calls, or (b) create separate conftest for scan engine tests
- Some modules (scan_engine/executor.py) require async test support (`pytest-asyncio`)

### Recommended Priority

1. **Router CRUD endpoints** (racks, switch_classes, switch_models, snmp_profiles, settings, scan_settings) -- easy wins, pattern matches existing credential tests
2. **scan_engine/db_helpers.py** -- pure functions, easy to test
3. **scan_engine/dns.py** and `scan_engine/ping.py` -- mock socket/subprocess
4. **shared/state.py** -- mock Redis, test in-memory fallback
5. **routers/topology.py** -- complex but high value
6. **scan_engine/executor.py** -- requires substantial mocking but most critical

### Effort Estimate

- **Complexity**: High
- **Easy wins** (router CRUD): ~6 new test files, 1-2 hours each
- **Medium** (helpers, state): ~4 new test files, 2-3 hours each
- **Hard** (executor, scanner, topology): ~3 new test files, 4-6 hours each
- **New dependencies**: `pytest-asyncio` (for executor tests)
- **Risk**: Low -- tests are additive, no production code changes

---

## 8. PostgreSQL-Specific Integration Tests

### Current SQLite Test Setup

The test suite uses SQLite in-memory with several compatibility patches (`conftest.py`):

1. **JSONB -> JSON patch** (line 10-11): `_pg.JSONB = _JSON` -- replaces PostgreSQL JSONB column type with plain JSON for SQLite
2. **StaticPool** (line 29): Single shared connection for all test operations
3. **check_same_thread=False**: Required for SQLite multi-thread access
4. **Module mocking** (line 14-15): `pysnmp`, `snmp_scanner`, `scan_engine` mocked entirely

### What SQLite Misses

| PostgreSQL Feature | SQLite Behavior | Impact |
|-------------------|-----------------|--------|
| **JSONB operators** (`@>`, `?`, `->`, `->>`) | Not supported | JSONB queries in topology/scan results untested |
| **CASCADE deletes** | Partially supported (must enable FK pragma) | 3 migrations add CASCADE; untested behavior |
| **Connection pooling** (pool_size, max_overflow) | N/A (single connection) | Pool exhaustion bugs hidden |
| **Transaction isolation** (READ COMMITTED) | SERIALIZABLE only | Concurrency bugs hidden |
| **func.now() / server_default** | Different implementation | Timestamp-related regressions possible |
| **UNIQUE constraint violations** | Same error type but different message | Error handling code may pass in SQLite, fail in PG |
| **Text collation** | Different from PG | Case-sensitive queries may differ |

### Recommended Implementation

**Option A: Docker-based PG tests (Recommended)**

Use `testcontainers` or a docker-compose test profile:

```python
# conftest_pg.py
import pytest

@pytest.fixture(scope="session")
def pg_engine():
    # Use testcontainers-python to spin up a PG container
    from testcontainers.postgres import PostgresContainer
    with PostgresContainer("postgres:16") as pg:
        engine = create_engine(pg.get_connection_url())
        Base.metadata.create_all(bind=engine)
        yield engine
```

**Option B: CI-only PG service**

Use GitHub Actions service container for PG, run tests with `DATABASE_URL` pointing to it.

### What to Test with PostgreSQL

1. **JSONB column operations**: Verify `snapshot_before`/`snapshot_after` columns in DryRunResult work with PG JSONB
2. **CASCADE deletes**: Verify deleting a Rack cascades to Device, deleting an SnmpProfile cascades to Credential
3. **Concurrent scan locks**: Test `acquire_scan_lock` / `release_scan_lock` under concurrent access
4. **Connection pool behavior**: Test pool_size=10, max_overflow=20 under load
5. **Alembic migrations**: Run full migration chain against a fresh PG database

### Effort Estimate

- **Complexity**: Medium-High
- **New files**: 1 conftest_pg.py, 3-5 PG-specific test files
- **New dependencies**: `testcontainers[postgres]` or CI configuration
- **Risk**: Medium -- tests are additive, but CI pipeline changes needed
- **Infrastructure**: Either local Docker or CI service container required

---

## Summary Matrix

| # | Item | Complexity | Files Changed | Risk | Dependencies | Recommended Order |
|---|------|-----------|---------------|------|-------------|-------------------|
| 1 | Centralized config | Medium | 8 + 1 new | Low | pydantic-settings | 1st |
| 2 | Configurable log level | Trivial | 1 | None | Can combine with #1 | 1st (with #1) |
| 3 | Token revocation | Medium | 2 | Medium | Redis (already in stack) | 3rd |
| 4 | Health check enhancements | Low | 1 | Low | None | 2nd |
| 5 | TypeScript migration | High (volume) | 35 | Low | None | Ongoing/parallel |
| 6 | Frontend component tests | Medium-High | 10+ new test files | Low | None (libs installed) | Ongoing/parallel |
| 7 | Backend test coverage | High | 13+ new test files | Low | pytest-asyncio | Ongoing/parallel |
| 8 | PG integration tests | Medium-High | 5+ new files | Medium | testcontainers | After #7 baseline |

### Recommended Implementation Order

1. **Items 1+2** (Centralized config + log level) -- Foundational, reduces tech debt for all future work
2. **Item 4** (Health check) -- Quick win, high operational value
3. **Item 3** (Token revocation) -- Security improvement, moderate effort
4. **Items 5+6+7** (TypeScript, frontend tests, backend tests) -- Parallel workstreams, can be done incrementally
5. **Item 8** (PG integration tests) -- Build on top of expanded backend test coverage
