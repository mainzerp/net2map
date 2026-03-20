# P1 Implementation Plan

Detailed step-by-step plan for all P1 items (excluding project-definition update, PG integration tests, and full 35-file TS migration).

---

## Checklist

### Phase A: Backend Config & Logging
- [ ] **A1** Create `backend/config.py` with Pydantic BaseSettings covering all 15 env vars
- [ ] **A2** Update `backend/database.py` to import from config
- [ ] **A3** Update `backend/celery_app.py` to import from config
- [ ] **A4** Update `backend/shared/auth.py` to import from config
- [ ] **A5** Update `backend/shared/crypto.py` to import from config
- [ ] **A6** Update `backend/shared/redis_client.py` to import from config
- [ ] **A7** Update `backend/routers/ws.py` to import from config
- [ ] **A8** Update `backend/main.py` to import from config (CORS_ORIGIN + LOG_LEVEL)
- [ ] **A9** Update `backend/alembic/env.py` to import from config
- [ ] **A10** Add `pydantic-settings` to requirements.txt

### Phase B: Security Hardening
- [ ] **B1** Add JTI claim + blacklist check to `backend/shared/auth.py`
- [ ] **B2** Add logout + revoke-all endpoints to `backend/routers/auth.py`
- [ ] **B3** Update frontend `api.ts` logout to call backend `/api/auth/logout`
- [ ] **B4** Enhance `backend/routers/health.py` with DB/Redis/Celery checks

### Phase C: Frontend TypeScript Migration (first batch ~12 files)
- [x] **C1** Create `frontend/src/types.ts` with shared interfaces
- [x] **C2** Migrate `store.js` -> `store.ts`
- [x] **C3** Migrate `hooks/useMapBackground.js` -> `.ts`
- [x] **C4** Migrate `hooks/useRackOrders.js` -> `.ts`
- [x] **C5** Migrate `hooks/useScanProgress.js` -> `.ts`
- [x] **C6** Migrate `hooks/useTopologyData.js` -> `.ts`
- [x] **C7** Migrate `pages/DevicesPage.jsx` -> `.tsx`
- [x] **C8** Migrate `pages/NetworkPage.jsx` -> `.tsx`
- [x] **C9** Migrate `pages/LoginPage.jsx` -> `.tsx`
- [x] **C10** Migrate `pages/LogsPage.jsx` -> `.tsx`
- [x] **C11** Migrate `pages/DashboardPage.jsx` -> `.tsx`
- [x] **C12** Migrate `pages/MapPage.jsx` -> `.tsx`
- [x] **C13** Migrate `pages/SettingsPage.jsx` -> `.tsx`
- [x] **C14** Update all import paths referencing renamed files

### Phase D: Testing
- [ ] **D1** Create frontend test utilities (render helpers, mocks)
- [ ] **D2** Add LoginPage component test
- [ ] **D3** Add DashboardPage component test
- [ ] **D4** Add DeviceTable component test
- [ ] **D5** Add backend test for enhanced health check
- [ ] **D6** Add backend test for config module
- [ ] **D7** Add backend test for token revocation (logout, revoke-all, blacklisted token rejection)
- [ ] **D8** Add backend test for topology router
- [ ] **D9** Add backend test for settings router
- [ ] **D10** Add backend test for `scan_engine/dns.py`
- [ ] **D11** Add backend test for `scan_engine/ping.py`

---

## Phase A: Backend Config & Logging

### Step A1: Create `backend/config.py`

**New file:** `backend/config.py`

**Dependencies:** None (first step)

```python
"""Centralized configuration via Pydantic BaseSettings."""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://netmap:netmap_pw@postgres/netmap"

    # Redis / Celery
    redis_url: str = ""

    # CORS
    cors_origin: str = "http://localhost:3000"

    # Authentication
    jwt_secret: str = ""
    secret_token: str = ""  # legacy single-token auth
    jwt_expiry_hours: int = 24
    encryption_key: str = ""

    # Seed data
    default_admin_password: str = "changeme"

    # Logging
    log_level: str = "INFO"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
```

Key decisions:
- `redis_url` default is `""` (empty). This matches `shared/redis_client.py` behavior and fixes the inconsistency where `celery_app.py` defaulted to `"redis://localhost:6379/0"`. Celery will now require explicit `REDIS_URL` configuration (Docker sets this via docker-compose.yml already).
- Module-level singleton `settings` is imported everywhere. Pydantic reads env vars at import time, which matches the existing `os.getenv()` behavior.
- `model_config` uses dict form (pydantic-settings v2 style).

**Verification:** `python -c "from config import settings; print(settings.model_dump())"`

---

### Step A2: Update `backend/database.py`

**File:** `backend/database.py`

**Change:** Replace `os.environ.get("DATABASE_URL", ...)` at line 11 with import from config.

```python
# Remove: import os
# Remove: DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://netmap:netmap_pw@postgres/netmap")
# Add:
from config import settings

DATABASE_URL = settings.database_url
```

The rest of the file (`_engine_kwargs`, `create_engine`, etc.) stays identical since it references the module-level `DATABASE_URL` variable.

**Dependencies:** A1

---

### Step A3: Update `backend/celery_app.py`

**File:** `backend/celery_app.py`

**Change:** Replace `os.getenv("REDIS_URL", "redis://localhost:6379/0")` with config import.

```python
# Remove: import os
# Remove: REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
# Add:
from config import settings

REDIS_URL = settings.redis_url or "redis://localhost:6379/0"
```

Note: Keep `or "redis://localhost:6379/0"` fallback here because Celery requires a valid broker URL to even import. If `settings.redis_url` is empty, Celery will attempt localhost which is the expected dev behavior. The alternative is to make Celery conditional, but that is a larger refactor out of scope.

**Dependencies:** A1

---

### Step A4: Update `backend/shared/auth.py`

**File:** `backend/shared/auth.py`

**Change:** Replace all `os.getenv(...)` calls (lines 13, 15, 18) with config imports.

```python
# Remove: import os
# Remove lines 13-18 (the os.getenv calls)
# Add:
from config import settings

JWT_SECRET = settings.jwt_secret or settings.secret_token
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = settings.jwt_expiry_hours

_LEGACY_TOKEN = settings.secret_token
```

This preserves the fallback chain `JWT_SECRET -> SECRET_TOKEN` behavior. Type safety comes for free: `jwt_expiry_hours` is validated as `int` by Pydantic.

**Dependencies:** A1

---

### Step A5: Update `backend/shared/crypto.py`

**File:** `backend/shared/crypto.py`

**Change:** Replace `os.getenv("ENCRYPTION_KEY", "")` with config import.

```python
# Remove: import os
# Remove: _KEY = os.getenv("ENCRYPTION_KEY", "")
# Add:
from config import settings

_KEY = settings.encryption_key
```

**Dependencies:** A1

---

### Step A6: Update `backend/shared/redis_client.py`

**File:** `backend/shared/redis_client.py`

**Change:** Replace `os.getenv("REDIS_URL", "")` with config import.

```python
# Remove: import os
# Remove: REDIS_URL = os.getenv("REDIS_URL", "")
# Add:
from config import settings

REDIS_URL = settings.redis_url
```

**Dependencies:** A1

---

### Step A7: Update `backend/routers/ws.py`

**File:** `backend/routers/ws.py`

**Change:** In `_authenticate_ws()` function (~line 78-80), replace inline `os.getenv()` with config import.

```python
# In _authenticate_ws(), remove:
#   import os
#   jwt_secret = os.getenv("JWT_SECRET", os.getenv("SECRET_TOKEN", ""))
#   legacy_token = os.getenv("SECRET_TOKEN", "")
# Replace with:
from config import settings
# ...
def _authenticate_ws(token: str) -> None:
    jwt_secret = settings.jwt_secret or settings.secret_token
    legacy_token = settings.secret_token
    # ... rest unchanged
```

This eliminates the duplicated auth logic that reads env vars independently.

**Dependencies:** A1

---

### Step A8: Update `backend/main.py` (CORS + LOG_LEVEL)

**File:** `backend/main.py`

**Changes:**
1. Replace `CORS_ORIGIN = os.getenv("CORS_ORIGIN", ...)` with config import
2. Replace hardcoded `logging.basicConfig(level=logging.INFO, ...)` with configurable level
3. Replace startup checks (`os.getenv("JWT_SECRET")`, `os.getenv("SECRET_TOKEN")`, `os.getenv("ENCRYPTION_KEY")`) with config references

```python
# Add: from config import settings

# Replace line 28:
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(levelname)s %(name)s: %(message)s",
)

# Replace line 31:
CORS_ORIGIN = settings.cors_origin

# Replace startup env var checks in lifespan():
    if not settings.jwt_secret and not settings.secret_token:
        _log.critical("SECURITY: No authentication configured ...")
    if not settings.encryption_key:
        _log.critical("SECURITY: ENCRYPTION_KEY is not set ...")
```

Remove the `import os` line if no other `os` usage remains (check for `threading` etc. -- `os` is no longer needed after this change).

**Dependencies:** A1

---

### Step A9: Update `backend/alembic/env.py`

**File:** `backend/alembic/env.py`

**Change:** Replace `os.environ.get("DATABASE_URL")` with config import.

```python
# Remove:
# _db_url = os.environ.get("DATABASE_URL")
# if not _db_url:
#     raise RuntimeError("DATABASE_URL environment variable is required for migrations")
# config.set_main_option("sqlalchemy.url", _db_url)
# Add:
from config import settings

if not settings.database_url:
    raise RuntimeError("DATABASE_URL environment variable is required for migrations")
config.set_main_option("sqlalchemy.url", settings.database_url)
```

**Dependencies:** A1

---

### Step A10: Add `pydantic-settings` to requirements.txt

**File:** `backend/requirements.txt`

**Change:** Add `pydantic-settings>=2.0.0` after the `pydantic` line.

```
pydantic==2.9.2
pydantic-settings>=2.0.0
```

**Dependencies:** None (can be done with A1)

**Verification for all of Phase A:**
```bash
cd backend
pip install pydantic-settings
python -c "from config import settings; print(settings.model_dump())"
python -c "from main import app; print('App loaded OK')"
pytest tests/ -x -q
```

---

## Phase B: Security Hardening

### Step B1: Add JTI + blacklist to `backend/shared/auth.py`

**File:** `backend/shared/auth.py`

**Dependencies:** A4 (config import done)

**Changes:**

1. Add `uuid` import
2. Modify `create_token()` to include `jti` claim
3. Add `_blacklist_token()` helper
4. Add `_is_token_blacklisted()` helper
5. Modify `_require_auth()` to check blacklist after JWT decode
6. Add `blacklist_all_user_tokens()` for admin revocation
7. Add `/api/auth/logout` to `_AUTH_EXEMPT_PATHS` -- actually no, logout requires auth to know which token to blacklist. Keep it auth-required.

```python
import uuid

def create_token(user_id: int, username: str, role: str) -> str:
    jti = str(uuid.uuid4())
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "jti": jti,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def blacklist_token(jti: str, remaining_seconds: int) -> bool:
    """Add a JTI to the Redis blacklist. Returns True if blacklisted successfully."""
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        return False
    try:
        r.set(f"token_blacklist:{jti}", "1", ex=max(1, remaining_seconds))
        return True
    except Exception:
        _log.warning("Failed to blacklist token jti=%s", jti)
        return False


def is_token_blacklisted(jti: str) -> bool:
    """Check if a JTI is blacklisted."""
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        return False  # If Redis is down, skip blacklist check (fail open -- matches existing Redis-optional pattern)
    try:
        return r.exists(f"token_blacklist:{jti}") > 0
    except Exception:
        return False


def blacklist_all_user_tokens(user_id: int) -> bool:
    """Mark a user-scoped revocation key. All tokens issued before this time are invalid."""
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        return False
    try:
        r.set(f"token_revoke_all:{user_id}", str(int(datetime.now(timezone.utc).timestamp())), ex=JWT_EXPIRY_HOURS * 3600)
        return True
    except Exception:
        return False


def _is_user_revoked(user_id: int, token_iat: int) -> bool:
    """Check if user-level revocation happened after this token was issued."""
    from shared.redis_client import get_redis
    r = get_redis()
    if not r:
        return False
    try:
        revoked_at = r.get(f"token_revoke_all:{user_id}")
        if revoked_at and token_iat < int(revoked_at):
            return True
        return False
    except Exception:
        return False
```

In `_require_auth()`, after the `jwt.decode()` call, add:

```python
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])

        # Check per-token blacklist
        jti = payload.get("jti")
        if jti and is_token_blacklisted(jti):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": {"code": "AUTH_REVOKED", "message": "Token has been revoked"}},
                headers={"WWW-Authenticate": "Bearer"},
            )

        # Check user-level revocation
        user_id = int(payload["sub"])
        iat = payload.get("iat", 0)
        if _is_user_revoked(user_id, iat):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": {"code": "AUTH_REVOKED", "message": "All sessions have been revoked"}},
                headers={"WWW-Authenticate": "Bearer"},
            )

        request.state.user = {
            "id": user_id,
            "username": payload["username"],
            "role": payload["role"],
        }
```

Also add `iat` to `create_token()`:

```python
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "jti": jti,
        "iat": int(datetime.now(timezone.utc).timestamp()),
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
    }
```

**Verification:** `pytest tests/test_auth.py -x -q` (existing tests should still pass; new tests in Phase D)

---

### Step B2: Add logout + revoke-all endpoints to `backend/routers/auth.py`

**File:** `backend/routers/auth.py`

**Dependencies:** B1

**Changes:** Add two new endpoints after the existing `refresh_token` endpoint:

```python
from shared.auth import (
    create_token, hash_password, verify_password, require_role,
    JWT_SECRET, JWT_ALGORITHM,
    blacklist_token, blacklist_all_user_tokens,  # new imports
)


@router.post("/api/auth/logout")
def logout_token(request: Request):
    """Blacklist the current token so it can no longer be used."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        api_error(401, "AUTH_REQUIRED", "Authentication required")
    token = auth_header[7:]
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        jti = payload.get("jti")
        exp = payload.get("exp", 0)
        if jti:
            remaining = max(0, exp - int(__import__("time").time()))
            blacklist_token(jti, remaining)
    except Exception:
        pass  # Token already invalid/expired -- no-op
    return {"status": "ok"}


@router.post("/api/auth/revoke-all", dependencies=[require_role("admin")])
def revoke_all_sessions(request: Request):
    """Revoke all active sessions for a given user (admin only).

    Body: {"user_id": int} -- revokes all tokens for that user.
    If no body, revokes all sessions for the requesting user.
    """
    user = getattr(request.state, "user", {})
    target_id = user.get("id", 0)
    blacklist_all_user_tokens(target_id)
    log_audit(request, "revoke_all_tokens", "user", str(target_id), {})
    return {"status": "ok", "user_id": target_id}
```

**Verification:** Manual curl test or wait for Phase D tests.

---

### Step B3: Update frontend logout to call backend

**File:** `frontend/src/api.ts`

**Dependencies:** B2

**Change:** Update the `logout()` function to call the backend endpoint before clearing localStorage:

```typescript
export async function logout(): Promise<void> {
  try {
    const headers = _getAuthHeader();
    if (headers.Authorization) {
      await fetch(`${API}/api/auth/logout`, {
        method: "POST",
        headers,
      });
    }
  } catch {
    // Best-effort -- still clear local state even if backend call fails
  }
  localStorage.removeItem("auth_token");
  localStorage.removeItem("auth_user");
}
```

This changes `logout` from synchronous to async. All callers currently do `logout(); navigate("/login")` which will still work since `logout()` returns a Promise that can be awaited or ignored (fire-and-forget is acceptable -- we still clear localStorage either way).

Find all callers of `logout` and verify they don't depend on synchronous behavior. The main caller is typically in `App.jsx` or a header/nav component.

**Verification:** `cd frontend && npx tsc --noEmit`

---

### Step B4: Enhance health check

**File:** `backend/routers/health.py`

**Dependencies:** None (independent of Phase A, but benefits from it)

**Replace entire file content:**

```python
"""Health check endpoint with component status verification."""
from fastapi import APIRouter
from sqlalchemy import text

from database import SessionLocal
from shared.redis_client import get_redis

router = APIRouter()


@router.get("/health", include_in_schema=False)
def health():
    checks = {}
    overall = "ok"

    # Database connectivity
    try:
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
            checks["database"] = "ok"
        finally:
            db.close()
    except Exception as e:
        checks["database"] = f"error: {e}"
        overall = "degraded"

    # Redis connectivity
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

    # Celery worker availability (only if Redis is available)
    if r:
        try:
            from celery_app import celery_app
            result = celery_app.control.ping(timeout=2)
            checks["celery"] = "ok" if result else "no_workers"
            if not result:
                overall = "degraded"
        except Exception:
            checks["celery"] = "unreachable"
            overall = "degraded"
    else:
        checks["celery"] = "not_configured"

    status_code = 200 if overall == "ok" else 503
    return {"status": overall, "checks": checks}
```

Note: Use `SessionLocal()` directly instead of `get_db()` generator to avoid FastAPI dependency injection in a simple health check. Short timeouts on Celery ping (2s) prevent the health check itself from becoming a bottleneck.

The return structure changes from `{"status": "ok"}` to `{"status": "ok"|"degraded", "checks": {...}}`. The `status_code` variable is computed but not used in the return -- to actually return 503, use a `JSONResponse`:

```python
    from fastapi.responses import JSONResponse
    return JSONResponse(
        content={"status": overall, "checks": checks},
        status_code=200 if overall == "ok" else 503,
    )
```

**Verification:** `pytest tests/test_health.py -x -q` (will need update -- see D5)

---

## Phase C: Frontend TypeScript Migration (first batch)

### Step C1: Create shared type definitions

**New file:** `frontend/src/types.ts`

**Dependencies:** None

This file defines interfaces for API response shapes, store state, and component props used across multiple files.

```typescript
// ── API response types ───────────────────────────────────────────────────────

export interface TopologyNode {
  id: number;
  ip: string;
  hostname: string;
  sys_name: string;
  vendor: string;
  model: string;
  mac: string;
  rack_id: number | null;
  class_id: number | null;
  model_id: number | null;
  x: number | null;
  y: number | null;
  ignored: boolean;
  role: string;
  ports_per_row: number;
  total_ports: number;
  ports: PortInfo[];
}

export interface PortInfo {
  port_id: string;
  name: string;
  oper_status: number;
  speed: number;
  vlan: number | null;
  tagged_vlans: number[];
  poe_status: string | null;
  found_on_port: FoundOnPort[];
}

export interface FoundOnPort {
  mac: string;
  ip: string;
  hostname: string;
  vlan: number | null;
}

export interface TopologyLink {
  id: number;
  local_ip: string;
  local_port: string;
  remote_ip: string;
  remote_port: string;
  local_sys_name: string;
  remote_sys_name: string;
}

export interface RackInfo {
  id: number;
  label: string;
  location: string;
  room: string;
  row_pos: number | null;
  col_pos: number | null;
}

export interface SwitchClass {
  id: number;
  name: string;
  color: string;
  allow_outside_rack: boolean;
}

export interface SwitchModel {
  id: number;
  name: string;
  ports_per_row: number;
  total_ports: number;
}

export interface TopologyData {
  nodes: TopologyNode[];
  links: TopologyLink[];
  racks: RackInfo[];
  classes: SwitchClass[];
  models: SwitchModel[];
}

// ── Store types ──────────────────────────────────────────────────────────────

export interface SelectedRack {
  id: number;
  label: string;
  location: string;
  devices: TopologyNode[];
}

export interface ScanProgress {
  type: string;
  job_id?: string;
  current_ip?: string;
  total?: number;
  completed?: number;
  message?: string;
  [key: string]: unknown;
}

export interface NetmapState {
  // Topology
  topology: TopologyData;
  selectedRack: SelectedRack | null;
  loadError: string | null;
  loadTopology: () => Promise<TopologyData | null>;
  setSelectedRack: (rack: SelectedRack | null | ((prev: SelectedRack | null) => SelectedRack | null)) => void;
  restoreSelectedRack: (data: TopologyData) => void;

  // Highlight
  highlightPortKey: string | null;
  setHighlightPortKey: (key: string | null) => void;
  clearHighlightPortKey: () => void;

  // Map background
  bgUrl: string | null;
  bgNat: { w: number; h: number } | null;
  bgOpacity: number;
  bgScale: number;
  bgColor: string;
  loadMapBackground: () => void;
  loadMapSettings: () => void;

  // Scan
  activeScanJobId: string | null;
  scanStatus: string | null;
  startScan: () => Promise<{ job_id: string; status: string }>;
  setScanStatus: (status: string | null) => void;
  clearScanJob: () => void;

  // Rack orders
  rackOrders: Record<string, string[]>;
  setRackOrders: (ordersOrFn: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>)) => void;
}

// ── Component prop types (shared across pages) ──────────────────────────────

export interface DeviceTableProps {
  role: "network" | "endpoint";
  title: string;
  subtitle: string;
  activeLabel: string;
  ignoredLabel: string;
  emptyMessage: string;
}
```

**Verification:** `cd frontend && npx tsc --noEmit`

---

### Step C2: Migrate `store.js` -> `store.ts`

**Rename:** `frontend/src/store.js` -> `frontend/src/store.ts`

**Dependencies:** C1

**Changes:**
1. Rename file from `.js` to `.ts`
2. Import `NetmapState` from `types.ts`
3. Add type annotation to the `create` call: `create<NetmapState>((set, get) => ({...}))`
4. Cast or annotate callback parameters where needed

Key pattern:

```typescript
import { create } from "zustand";
import { api, API, _getAuthHeader } from "./api";
import type { NetmapState, TopologyData, SelectedRack } from "./types";

const useNetmapStore = create<NetmapState>((set, get) => ({
  topology: { nodes: [], links: [], racks: [], classes: [], models: [] },
  selectedRack: null,
  loadError: null,

  loadTopology: async (): Promise<TopologyData | null> => {
    try {
      const data: TopologyData = await api.get("/api/topology");
      set({ topology: data, loadError: null });
      return data;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load topology";
      set({ loadError: msg });
      return null;
    }
  },
  // ... rest of store with minimal type annotations
}));

export default useNetmapStore;
```

Most of the function bodies remain identical. The main additions are:
- Generic type on `create<NetmapState>`
- Return type annotations on async functions
- `e: unknown` in catch blocks with `instanceof Error` narrowing
- Type annotation on `rackOrFn` parameter in `setSelectedRack`

**Verification:** `cd frontend && npx tsc --noEmit`

---

### Steps C3-C6: Migrate hooks

**Rename files:**
- `hooks/useMapBackground.js` -> `hooks/useMapBackground.ts`
- `hooks/useRackOrders.js` -> `hooks/useRackOrders.ts`
- `hooks/useScanProgress.js` -> `hooks/useScanProgress.ts`
- `hooks/useTopologyData.js` -> `hooks/useTopologyData.ts`

**Dependencies:** C2 (store must be `.ts` first)

**Pattern for each hook:**

`useMapBackground.ts`:
```typescript
import { useEffect, useRef } from "react";
import useNetmapStore from "../store";

export function useMapBackground() {
  // ... identical logic, no new types needed
  // Return type is inferred from the object literal
}
```

`useTopologyData.ts`:
```typescript
import { useEffect, useRef } from "react";
import useNetmapStore from "../store";
import type { TopologyData, SelectedRack } from "../types";

export function useTopologyData() {
  // ... identical logic
  // Return type inferred
}
```

`useScanProgress.ts`:
```typescript
import { useState, useEffect, useRef } from "react";
import { getStoredToken, api } from "../api";
import type { ScanProgress } from "../types";

export function useScanProgress(jobId: string | null): ScanProgress | null {
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ... rest with WebSocket typed
}
```

`useRackOrders.ts`:
```typescript
import useNetmapStore from "../store";
import type { TopologyNode } from "../types";

export function useRackOrders() {
  const rackOrders = useNetmapStore(s => s.rackOrders);
  const setRackOrders = useNetmapStore(s => s.setRackOrders);

  const reorderDevice = (
    deviceId: number,
    direction: "up" | "down",
    groupKey: string,
    rackId: number | null,
    rackDevicesInput: TopologyNode[],
  ) => {
    // ... same logic with types
  };

  // ... reorderClassSection with types
}
```

**Verification:** `cd frontend && npx tsc --noEmit`

---

### Steps C7-C13: Migrate page files

**Rename files** (`.jsx` -> `.tsx`):
- `pages/DevicesPage.jsx` -> `pages/DevicesPage.tsx`
- `pages/NetworkPage.jsx` -> `pages/NetworkPage.tsx`
- `pages/LoginPage.jsx` -> `pages/LoginPage.tsx`
- `pages/LogsPage.jsx` -> `pages/LogsPage.tsx`
- `pages/DashboardPage.jsx` -> `pages/DashboardPage.tsx`
- `pages/MapPage.jsx` -> `pages/MapPage.tsx`
- `pages/SettingsPage.jsx` -> `pages/SettingsPage.tsx`

**Dependencies:** C1 (types.ts), C2 (store.ts)

**Common patterns for all page migrations:**

1. Add `React.FormEvent<HTMLFormElement>` for form `onSubmit` handlers
2. Add `React.ChangeEvent<HTMLInputElement | HTMLSelectElement>` for input `onChange` handlers
3. Type `useState` generics where type cannot be inferred (e.g., `useState<string | null>(null)`)
4. Import prop types from `types.ts` for child component references
5. Add `e: unknown` in catch blocks

**DevicesPage.tsx / NetworkPage.tsx** (trivial -- 13 lines each):
```typescript
import DeviceTable from "../components/DeviceTable.jsx";
import type { DeviceTableProps } from "../types";

export default function DevicesPage(): JSX.Element {
  return <DeviceTable role="endpoint" title="Devices" ... />;
}
```
These are thin wrappers. The import of `DeviceTable.jsx` stays as-is (`.jsx` extension) because `DeviceTable` is not in this migration batch. `allowJs: true` handles it.

**LoginPage.tsx**: Add `React.FormEvent<HTMLFormElement>` to `handleSubmit`, type state variables.

**LogsPage.tsx**: Type the log entry shape, add event handler types.

**DashboardPage.tsx**: Import `TopologyData`, `ScanProgress` types. Type API responses.

**MapPage.tsx**: Import topology types, type filter state.

**SettingsPage.tsx**: Type tab state, profile arrays, file ref, error strings.

### Step C14: Update import paths

After renaming, update all cross-references:
- Any file that imports `from "../store.js"` -> `from "../store"` (drop extension)
- Any file that imports `from "../hooks/useScanProgress.js"` -> drop `.js`
- Any file importing page files by explicit extension

Note: Vite's module resolution handles extensionless imports for both `.ts` and `.tsx`. The remaining `.jsx` component files that import the store will work because `allowJs: true` is set and Vite resolves both extensions.

Search pattern: `grep -r "store\.js\|useScanProgress\.js\|useTopologyData\.js\|useMapBackground\.js\|useRackOrders\.js" frontend/src/`

Update each import to drop the `.js` extension.

**Verification for all of Phase C:**
```bash
cd frontend
npx tsc --noEmit
npm run build
```

---

## Phase D: Testing

### Step D1: Create frontend test utilities

**New file:** `frontend/src/__tests__/test-utils.tsx`

**Dependencies:** C2 (store must be `.ts`)

```tsx
import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Wrapper that provides Router context for components using useNavigate
function AllProviders({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function renderWithRouter(ui: React.ReactElement, options?: RenderOptions) {
  return render(ui, { wrapper: AllProviders, ...options });
}

export { renderWithRouter };
```

Also add `@testing-library/user-event` to devDependencies if not present:
```bash
cd frontend && npm install -D @testing-library/user-event @testing-library/jest-dom
```

**Verification:** `cd frontend && npx tsc --noEmit`

---

### Step D2: Add LoginPage component test

**New file:** `frontend/src/__tests__/LoginPage.test.tsx`

**Dependencies:** D1, C9 (LoginPage.tsx)

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "./test-utils";
import LoginPage from "../pages/LoginPage";

// Mock the api module
vi.mock("../api", () => ({
  API: "http://localhost:8000",
  login: vi.fn(),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders login form with username and password fields", () => {
    renderWithRouter(<LoginPage />);
    expect(screen.getByText("NetMap Login")).toBeDefined();
    expect(screen.getByLabelText(/username/i)).toBeDefined();
    expect(screen.getByLabelText(/password/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeDefined();
  });

  it("shows error on failed login", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: "Invalid credentials" } }),
    });
    renderWithRouter(<LoginPage />);
    await userEvent.type(screen.getByLabelText(/username/i), "baduser");
    await userEvent.type(screen.getByLabelText(/password/i), "badpass");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeDefined();
    });
  });

  it("calls login on successful submission", async () => {
    const { login } = await import("../api");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "jwt123", username: "admin", role: "admin" }),
    });
    renderWithRouter(<LoginPage />);
    await userEvent.type(screen.getByLabelText(/username/i), "admin");
    await userEvent.type(screen.getByLabelText(/password/i), "pass123");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(login).toHaveBeenCalledWith("jwt123", { username: "admin", role: "admin" });
    });
  });
});
```

Note: The `screen.getByLabelText` selectors depend on the `<span>` text inside `<label>`. If `@testing-library` cannot match by label text, use `screen.getByPlaceholderText` or `screen.getByRole("textbox")` instead. Adjust selectors after first test run.

**Verification:** `cd frontend && npm test`

---

### Step D3: Add DashboardPage component test

**New file:** `frontend/src/__tests__/DashboardPage.test.tsx`

**Dependencies:** D1

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

// Mock api module
vi.mock("../api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
  API: "",
  VENDOR_LABEL: {},
  VENDOR_COLOR: {},
  VENDOR_ICON: {},
}));

// Mock store
vi.mock("../store", () => {
  const store = {
    activeScanJobId: null,
    startScan: vi.fn(),
    clearScanJob: vi.fn(),
  };
  return { default: (selector: (s: typeof store) => unknown) => selector(store) };
});

// Mock hooks
vi.mock("../hooks/useScanProgress", () => ({
  useScanProgress: () => null,
}));

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading state initially then shows dashboard data", async () => {
    const { api } = await import("../api");
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === "/api/topology") {
        return Promise.resolve({ nodes: [], links: [], racks: [], classes: [] });
      }
      if (url === "/api/stats") {
        return Promise.resolve({ device_count: 5, port_count: 100 });
      }
      return Promise.resolve({});
    });

    const DashboardPage = (await import("../pages/DashboardPage")).default;
    renderWithRouter(<DashboardPage />);

    // Should eventually render without error
    await waitFor(() => {
      expect(screen.queryByText(/failed to load/i)).toBeNull();
    });
  });
});
```

**Verification:** `cd frontend && npm test`

---

### Step D4: Add DeviceTable component test

**New file:** `frontend/src/__tests__/DeviceTable.test.tsx`

**Dependencies:** D1

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

// Mock api
vi.mock("../api", () => ({
  api: { get: vi.fn(), put: vi.fn(), patch: vi.fn() },
  API: "",
  speedLabel: (s: number) => s >= 1000 ? `${s / 1000}G` : `${s}M`,
  normPort: (p: string) => (p || "").trim().toLowerCase(),
  buildPortLinkMap: () => ({}),
  VENDOR_LABEL: {},
  VENDOR_COLOR: {},
  VENDOR_ICON: {},
}));

// Mock store to provide highlightPortKey
vi.mock("../store", () => {
  const store = { highlightPortKey: null, setHighlightPortKey: vi.fn(), clearHighlightPortKey: vi.fn() };
  return { default: (selector: (s: typeof store) => unknown) => selector(store) };
});

describe("DeviceTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no devices returned", async () => {
    const { api } = await import("../api");
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      nodes: [], links: [], racks: [], classes: [], models: [],
    });

    const DeviceTable = (await import("../components/DeviceTable")).default;
    renderWithRouter(
      <DeviceTable
        role="endpoint"
        title="Devices"
        subtitle="End devices"
        activeLabel="ACTIVE"
        ignoredLabel="IGNORED"
        emptyMessage="No devices found"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("No devices found")).toBeDefined();
    });
  });
});
```

**Verification:** `cd frontend && npm test`

---

### Step D5: Backend test for enhanced health check

**File:** `backend/tests/test_health.py` (overwrite existing 6-line test)

**Dependencies:** B4

```python
"""Tests for the enhanced health check endpoint."""
from unittest.mock import patch, MagicMock
import pytest


def test_health_all_ok(client):
    """When DB and Redis are healthy, status is ok."""
    with patch("routers.health.get_redis") as mock_redis, \
         patch("routers.health.SessionLocal") as mock_session_cls:
        mock_db = MagicMock()
        mock_session_cls.return_value = mock_db
        mock_r = MagicMock()
        mock_redis.return_value = mock_r
        mock_r.ping.return_value = True

        # Mock celery ping
        with patch("celery_app.celery_app") as mock_celery:
            mock_celery.control.ping.return_value = [{"worker": {"ok": "pong"}}]
            resp = client.get("/health")

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "checks" in data
    assert data["checks"]["database"] == "ok"


def test_health_db_down(client):
    """When DB is unreachable, status is degraded."""
    with patch("routers.health.SessionLocal") as mock_session_cls, \
         patch("routers.health.get_redis", return_value=None):
        mock_session_cls.side_effect = Exception("connection refused")
        resp = client.get("/health")

    assert resp.status_code in (200, 503)
    data = resp.json()
    assert data["status"] == "degraded"
    assert "error" in data["checks"]["database"]


def test_health_redis_not_configured(client):
    """When Redis is not configured, check reports not_configured."""
    with patch("routers.health.get_redis", return_value=None), \
         patch("routers.health.SessionLocal") as mock_session_cls:
        mock_db = MagicMock()
        mock_session_cls.return_value = mock_db
        resp = client.get("/health")

    data = resp.json()
    assert data["checks"]["redis"] == "not_configured"
```

**Verification:** `cd backend && python -m pytest tests/test_health.py -x -q`

---

### Step D6: Backend test for config module

**New file:** `backend/tests/test_config_module.py`

**Dependencies:** A1

```python
"""Tests for the centralized configuration module."""
import os
from unittest.mock import patch


def test_settings_reads_env_vars():
    """Settings class reads from environment variables."""
    with patch.dict(os.environ, {
        "DATABASE_URL": "postgresql://test:test@localhost/testdb",
        "REDIS_URL": "redis://localhost:6379/1",
        "JWT_SECRET": "supersecret",
        "LOG_LEVEL": "DEBUG",
        "JWT_EXPIRY_HOURS": "48",
    }):
        # Re-import to pick up patched env
        from pydantic_settings import BaseSettings

        class TestSettings(BaseSettings):
            database_url: str = "postgresql://netmap:netmap_pw@postgres/netmap"
            redis_url: str = ""
            jwt_secret: str = ""
            jwt_expiry_hours: int = 24
            log_level: str = "INFO"
            model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

        s = TestSettings()
        assert s.database_url == "postgresql://test:test@localhost/testdb"
        assert s.redis_url == "redis://localhost:6379/1"
        assert s.jwt_secret == "supersecret"
        assert s.log_level == "DEBUG"
        assert s.jwt_expiry_hours == 48


def test_settings_defaults():
    """Settings class uses defaults when env vars not set."""
    with patch.dict(os.environ, {}, clear=True):
        from pydantic_settings import BaseSettings

        class TestSettings(BaseSettings):
            database_url: str = "postgresql://netmap:netmap_pw@postgres/netmap"
            redis_url: str = ""
            jwt_secret: str = ""
            jwt_expiry_hours: int = 24
            log_level: str = "INFO"
            model_config = {"env_file": None}

        s = TestSettings()
        assert s.database_url == "postgresql://netmap:netmap_pw@postgres/netmap"
        assert s.redis_url == ""
        assert s.jwt_expiry_hours == 24


def test_settings_invalid_jwt_expiry():
    """Non-numeric JWT_EXPIRY_HOURS raises validation error."""
    from pydantic import ValidationError
    from pydantic_settings import BaseSettings

    with patch.dict(os.environ, {"JWT_EXPIRY_HOURS": "not_a_number"}):
        class TestSettings(BaseSettings):
            jwt_expiry_hours: int = 24
            model_config = {"env_file": None}

        import pytest
        with pytest.raises(ValidationError):
            TestSettings()
```

**Verification:** `cd backend && python -m pytest tests/test_config_module.py -x -q`

---

### Step D7: Backend test for token revocation

**New file:** `backend/tests/test_token_revocation.py`

**Dependencies:** B1, B2

```python
"""Tests for token revocation (logout, revoke-all, blacklist check)."""
from unittest.mock import patch, MagicMock

import pytest
from shared.auth import create_token, hash_password
from database import User


@pytest.fixture
def admin_user(db):
    user = User(
        username="revokeadmin", email="revoke@test.com",
        hashed_pw=hash_password("TestPass123"), role="admin", is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def admin_token(admin_user):
    return create_token(admin_user.id, admin_user.username, admin_user.role)


def test_logout_blacklists_token(client, admin_user, admin_token):
    """POST /api/auth/logout should blacklist the token."""
    mock_redis = MagicMock()
    with patch("shared.auth.get_redis", return_value=mock_redis), \
         patch("routers.auth.get_redis", return_value=mock_redis):
        mock_redis.exists.return_value = 0
        resp = client.post(
            "/api/auth/logout",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    # Verify set was called with a blacklist key
    mock_redis.set.assert_called()
    call_args = mock_redis.set.call_args
    assert call_args[0][0].startswith("token_blacklist:")


def test_blacklisted_token_is_rejected(client, admin_user, admin_token):
    """A blacklisted token should be rejected with AUTH_REVOKED."""
    mock_redis = MagicMock()
    mock_redis.exists.return_value = 1  # Token is blacklisted
    with patch("shared.auth.get_redis", return_value=mock_redis):
        resp = client.get(
            "/api/settings",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"]["code"] == "AUTH_REVOKED"


def test_revoke_all_sets_user_revocation(client, admin_user, admin_token):
    """POST /api/auth/revoke-all should set user-level revocation."""
    mock_redis = MagicMock()
    mock_redis.exists.return_value = 0
    mock_redis.get.return_value = None
    with patch("shared.auth.get_redis", return_value=mock_redis), \
         patch("shared.audit.log_audit"):
        resp = client.post(
            "/api/auth/revoke-all",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    # Verify user revocation key was set
    revoke_calls = [c for c in mock_redis.set.call_args_list if "token_revoke_all:" in str(c)]
    assert len(revoke_calls) > 0
```

**Verification:** `cd backend && python -m pytest tests/test_token_revocation.py -x -q`

---

### Step D8: Backend test for topology router

**New file:** `backend/tests/test_topology.py`

**Dependencies:** None (uses existing conftest)

```python
"""Tests for the topology router endpoints."""
from unittest.mock import patch

from database import Device, Credential, Rack as RackModel, SwitchClass
from shared.auth import hash_password, create_token


def _seed_topology(db):
    """Seed minimal topology data for testing."""
    rack = RackModel(label="Rack-A", location="Room 1", room="DC1")
    db.add(rack)
    db.flush()

    cls = SwitchClass(name="Access", color="#00ff00")
    db.add(cls)
    db.flush()

    dev = Device(
        ip="10.0.0.1", hostname="switch-1", sys_name="switch-1",
        vendor="generic", mac="aa:bb:cc:dd:ee:ff",
        rack_id=rack.id, class_id=cls.id, role="network",
    )
    db.add(dev)
    db.flush()

    cred = Credential(ip="10.0.0.1", snmp_community="public")
    db.add(cred)
    db.commit()
    return {"rack": rack, "cls": cls, "dev": dev}


def test_get_topology_returns_nodes(client, db, auth_headers):
    _seed_topology(db)
    resp = client.get("/api/topology", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "nodes" in data
    assert "links" in data
    assert "racks" in data
    assert len(data["nodes"]) == 1
    assert data["nodes"][0]["ip"] == "10.0.0.1"


def test_get_topology_etag_304(client, db, auth_headers):
    """Second request with matching ETag returns 304."""
    _seed_topology(db)
    resp1 = client.get("/api/topology", headers=auth_headers)
    etag = resp1.headers.get("etag")
    if etag:
        resp2 = client.get("/api/topology", headers={**auth_headers, "if-none-match": etag})
        assert resp2.status_code == 304


def test_get_topology_empty(client, db, auth_headers):
    """Topology with no seeded data returns empty lists."""
    resp = client.get("/api/topology", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["nodes"] == []
    assert data["links"] == []
```

**Verification:** `cd backend && python -m pytest tests/test_topology.py -x -q`

---

### Step D9: Backend test for settings router

**New file:** `backend/tests/test_settings_router.py`

**Dependencies:** None (uses existing conftest)

```python
"""Tests for the settings and stats endpoints."""
from database import User
from shared.auth import hash_password, create_token


def test_list_settings_empty(client, auth_headers):
    resp = client.get("/api/settings", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json() == []


def test_update_setting_creates_new(client, db, jwt_headers):
    resp = client.put(
        "/api/settings/theme",
        json={"value": "dark"},
        headers=jwt_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["key"] == "theme"
    assert resp.json()["value"] == "dark"


def test_update_setting_updates_existing(client, db, jwt_headers):
    client.put("/api/settings/theme", json={"value": "dark"}, headers=jwt_headers)
    resp = client.put("/api/settings/theme", json={"value": "light"}, headers=jwt_headers)
    assert resp.status_code == 200
    assert resp.json()["value"] == "light"


def test_get_stats(client, db, auth_headers):
    resp = client.get("/api/stats", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "device_count" in data
    assert "port_count" in data
    assert data["device_count"] == 0
```

**Verification:** `cd backend && python -m pytest tests/test_settings_router.py -x -q`

---

### Step D10: Backend test for `scan_engine/dns.py`

**New file:** `backend/tests/test_dns.py`

**Dependencies:** None

```python
"""Tests for scan_engine/dns.py -- DNS resolution helpers."""
from unittest.mock import patch, MagicMock

# Must unmock scan_engine for these tests
import importlib


def _import_dns_module():
    """Import the real dns module (not the mocked one from conftest)."""
    import sys
    # Temporarily remove mock
    saved = sys.modules.pop("scan_engine", None)
    saved_dns = sys.modules.pop("scan_engine.dns", None)
    try:
        from scan_engine import dns
        importlib.reload(dns)
        return dns
    finally:
        if saved:
            sys.modules["scan_engine"] = saved
        if saved_dns:
            sys.modules["scan_engine.dns"] = saved_dns


def test_resolve_ip_by_sys_name():
    dns_mod = _import_dns_module()
    switch_data = {
        "10.0.0.1": MagicMock(sys_name="switch-core-01"),
        "10.0.0.2": MagicMock(sys_name="switch-access-01"),
    }
    result = dns_mod._resolve_ip("switch-core", switch_data)
    assert result == "10.0.0.1"


def test_resolve_ip_fallback_to_socket():
    dns_mod = _import_dns_module()
    with patch("socket.gethostbyname", return_value="192.168.1.1"):
        result = dns_mod._resolve_ip("unknown-host", {})
    assert result == "192.168.1.1"


def test_resolve_ip_returns_empty_on_failure():
    dns_mod = _import_dns_module()
    with patch("socket.gethostbyname", side_effect=Exception("not found")):
        result = dns_mod._resolve_ip("unknown-host", {})
    assert result == ""


def test_resolve_host_caching():
    dns_mod = _import_dns_module()
    cache = {"10.0.0.1": "switch-1.local"}
    with patch("shared.state._log_event"):
        result = dns_mod._resolve_host("10.0.0.1", cache)
    assert result == "switch-1.local"


def test_resolve_host_system_dns():
    dns_mod = _import_dns_module()
    cache = {}
    with patch("socket.gethostbyaddr", return_value=("host.local", [], [])), \
         patch("shared.state._log_event"):
        result = dns_mod._resolve_host("10.0.0.5", cache)
    assert result == "host.local"
    assert cache["10.0.0.5"] == "host.local"


def test_evict_dns_cache():
    dns_mod = _import_dns_module()
    cache = {f"10.0.0.{i}": f"host-{i}" for i in range(15000)}
    dns_mod._evict_dns_cache(cache)
    assert len(cache) < 15000
```

Note: This test module needs special handling because `conftest.py` mocks `scan_engine` entirely. The `_import_dns_module()` helper temporarily removes the mock to test the real module. An alternative approach is to create a separate conftest for scan engine tests, but this approach works without structural changes.

**Verification:** `cd backend && python -m pytest tests/test_dns.py -x -q`

---

### Step D11: Backend test for `scan_engine/ping.py`

**New file:** `backend/tests/test_ping.py`

**Dependencies:** None

```python
"""Tests for scan_engine/ping.py -- ICMP ping helpers."""
from unittest.mock import patch, MagicMock
import importlib
import platform


def _import_ping_module():
    import sys
    saved = sys.modules.pop("scan_engine", None)
    saved_ping = sys.modules.pop("scan_engine.ping", None)
    try:
        from scan_engine import ping
        importlib.reload(ping)
        return ping
    finally:
        if saved:
            sys.modules["scan_engine"] = saved
        if saved_ping:
            sys.modules["scan_engine.ping"] = saved_ping


def test_build_ping_cmd_windows():
    ping_mod = _import_ping_module()
    with patch("platform.system", return_value="Windows"):
        cmd = ping_mod._build_ping_cmd("10.0.0.1", 2)
    assert cmd == ["ping", "-n", "1", "-w", "2000", "10.0.0.1"]


def test_build_ping_cmd_linux():
    ping_mod = _import_ping_module()
    with patch("platform.system", return_value="Linux"):
        cmd = ping_mod._build_ping_cmd("10.0.0.1", 2)
    assert cmd == ["ping", "-c", "1", "-W", "2", "10.0.0.1"]


def test_ping_host_success():
    ping_mod = _import_ping_module()
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "Reply from 10.0.0.1: bytes=32 time=5ms TTL=64"
    mock_result.stderr = ""
    with patch("subprocess.run", return_value=mock_result):
        reachable, rtt = ping_mod._ping_host("10.0.0.1", timeout_sec=2)
    assert reachable is True
    assert rtt == 5


def test_ping_host_unreachable():
    ping_mod = _import_ping_module()
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stdout = "Request timed out."
    mock_result.stderr = ""
    with patch("subprocess.run", return_value=mock_result):
        reachable, rtt = ping_mod._ping_host("10.0.0.1", timeout_sec=1)
    assert reachable is False


def test_ping_host_empty_ip():
    ping_mod = _import_ping_module()
    reachable, rtt = ping_mod._ping_host("", timeout_sec=1)
    assert reachable is False
    assert rtt == 0
```

**Verification:** `cd backend && python -m pytest tests/test_ping.py -x -q`

---

## Dependency Graph

```
A1 (config.py) ─┬─> A2 (database.py)
                 ├─> A3 (celery_app.py)
                 ├─> A4 (shared/auth.py) ──> B1 (JTI + blacklist)
                 ├─> A5 (shared/crypto.py)         │
                 ├─> A6 (redis_client.py)           ▼
                 ├─> A7 (routers/ws.py)     B2 (logout endpoints) ──> B3 (frontend logout)
                 ├─> A8 (main.py + LOG_LEVEL)
                 └─> A9 (alembic/env.py)

A10 (requirements.txt) -- do with A1

B4 (health check) -- independent

C1 (types.ts) ──> C2 (store.ts) ──> C3-C6 (hooks) ──> C7-C13 (pages) ──> C14 (import paths)

D1 (test utils) ──> D2-D4 (frontend tests)
D5 (test health) -- after B4
D6 (test config) -- after A1
D7 (test revocation) -- after B1, B2
D8 (test topology) -- independent
D9 (test settings) -- independent
D10 (test dns) -- independent
D11 (test ping) -- independent
```

## Execution Order

1. **A1 + A10** -- Create config.py + add pydantic-settings dependency
2. **A2-A9** -- Update all 8 consumer files (can be done in one batch)
3. **B4** -- Health check enhancement (independent)
4. **B1** -- JTI + blacklist in auth.py
5. **B2** -- Logout + revoke-all endpoints
6. **B3** -- Frontend logout update
7. **C1** -- Create types.ts
8. **C2** -- Migrate store.ts
9. **C3-C6** -- Migrate hooks (batch)
10. **C7-C13** -- Migrate pages (batch)
11. **C14** -- Fix import paths
12. **D1** -- Frontend test utilities
13. **D2-D4** -- Frontend component tests (batch)
14. **D5-D11** -- Backend tests (batch, all independent of each other)

## Full Verification After All Steps

```bash
# Backend
cd backend
pip install pydantic-settings
python -m pytest tests/ -x -q --tb=short

# Frontend
cd frontend
npm install -D @testing-library/user-event @testing-library/jest-dom
npx tsc --noEmit
npm run build
npm test

# Docker full stack
cd ..
docker compose build
docker compose up -d
curl http://localhost:8000/health
```
