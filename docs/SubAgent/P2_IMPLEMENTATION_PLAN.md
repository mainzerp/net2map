# P2 Implementation Plan

## Checklist

- [ ] **P2-A1**: Audit log retention policy (backend)
- [ ] **P2-A2**: Request/response logging middleware (backend)
- [ ] **P2-A3**: Graceful shutdown handling (backend)
- [ ] **P2-B4**: Database backup/restore tooling (devops)
- [ ] **P2-C5**: Frontend lazy loading (frontend)
- [ ] **P2-C6**: Notification/toast system (frontend)
- [ ] **P2-C7**: Keyboard shortcuts (frontend)

---

## Phase P2-A: Backend Quick Wins

---

### P2-A1: Audit Log Retention Policy

**Goal:** Add configurable retention period for audit logs with automatic Celery Beat cleanup and a manual admin purge endpoint.

#### Step 1: Add config setting

**File to modify:** `backend/config.py`

Add `audit_retention_days` to the `Settings` class:

```python
# Audit
audit_retention_days: int = 90
```

Place it after the `log_level` field.

#### Step 2: Add Celery Beat cleanup task

**File to modify:** `backend/tasks.py`

Add a new task `purge_old_audit_logs` at the bottom of the file:

```python
@celery_app.task
def purge_old_audit_logs():
    """Delete audit log entries older than AUDIT_RETENTION_DAYS."""
    from config import settings
    from database import AuditLog, SessionLocal
    from datetime import datetime, timezone, timedelta

    if settings.audit_retention_days <= 0:
        return  # retention disabled

    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.audit_retention_days)
    db = SessionLocal()
    try:
        deleted = db.query(AuditLog).filter(AuditLog.timestamp < cutoff).delete()
        db.commit()
        _log_event(logging.INFO, "audit.purge.complete", deleted=deleted,
                   retention_days=settings.audit_retention_days)
    except Exception as exc:
        db.rollback()
        _log_event(logging.ERROR, "audit.purge.error", error=str(exc))
    finally:
        db.close()
```

#### Step 3: Register in Celery Beat schedule

**File to modify:** `backend/celery_app.py`

Add to `celery_app.conf.beat_schedule`:

```python
"purge-old-audit-logs": {
    "task": "tasks.purge_old_audit_logs",
    "schedule": 86400.0,  # once per day
},
```

#### Step 4: Add manual purge endpoint

**File to modify:** `backend/routers/audit.py`

Add a `DELETE /api/audit-logs/purge` endpoint restricted to admin role:

```python
from datetime import datetime, timezone, timedelta
from config import settings

@router.delete("/api/audit-logs/purge",
               dependencies=[require_role("admin")])
def purge_audit_logs(days: int = None, db: Session = Depends(get_db)):
    retention = days if days is not None else settings.audit_retention_days
    if retention <= 0:
        return {"deleted": 0, "message": "Retention disabled"}
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention)
    deleted = db.query(AuditLog).filter(AuditLog.timestamp < cutoff).delete()
    db.commit()
    return {"deleted": deleted, "cutoff": cutoff.isoformat()}
```

#### Step 5: Add tests

**File to modify:** `backend/tests/test_audit.py`

Add a new test class `TestAuditPurge`:

```python
class TestAuditPurge:
    """DELETE /api/audit-logs/purge"""

    def test_purge_deletes_old_entries(self, client, jwt_headers, db):
        from datetime import datetime, timezone, timedelta
        old = datetime.now(timezone.utc) - timedelta(days=120)
        recent = datetime.now(timezone.utc) - timedelta(days=10)
        db.add(AuditLog(username="u", action="a", resource="r",
                        resource_id="1", details={}, timestamp=old))
        db.add(AuditLog(username="u", action="a", resource="r",
                        resource_id="2", details={}, timestamp=recent))
        db.commit()
        resp = client.delete("/api/audit-logs/purge?days=90", headers=jwt_headers)
        assert resp.status_code == 200
        assert resp.json()["deleted"] == 1
        assert db.query(AuditLog).count() == 1

    def test_purge_requires_admin(self, client, viewer_jwt_headers):
        resp = client.delete("/api/audit-logs/purge", headers=viewer_jwt_headers)
        assert resp.status_code == 403

    def test_purge_custom_days(self, client, jwt_headers, db):
        from datetime import datetime, timezone, timedelta
        old = datetime.now(timezone.utc) - timedelta(days=5)
        db.add(AuditLog(username="u", action="a", resource="r",
                        resource_id="1", details={}, timestamp=old))
        db.commit()
        resp = client.delete("/api/audit-logs/purge?days=3", headers=jwt_headers)
        assert resp.status_code == 200
        assert resp.json()["deleted"] == 1
```

Add a unit test for the Celery task in a new `TestAuditPurgeTask` class within the same file:

```python
class TestAuditPurgeTask:
    def test_purge_task_runs(self, db, monkeypatch):
        from datetime import datetime, timezone, timedelta
        import tasks
        monkeypatch.setattr("tasks.SessionLocal", lambda: db)
        old = datetime.now(timezone.utc) - timedelta(days=120)
        db.add(AuditLog(username="u", action="a", resource="r",
                        resource_id="1", details={}, timestamp=old))
        db.commit()
        tasks.purge_old_audit_logs()
        assert db.query(AuditLog).count() == 0
```

#### Verification

```bash
cd backend && python -m pytest tests/test_audit.py -v
```

---

### P2-A2: Request/Response Logging Middleware

**Goal:** Add opt-in middleware that logs HTTP method, path, status code, and duration. Skip health/metrics endpoints. Gated by `REQUEST_LOG_ENABLED` env var.

#### Step 1: Add config settings

**File to modify:** `backend/config.py`

Add to the `Settings` class:

```python
# Request logging
request_log_enabled: bool = False
```

#### Step 2: Create the middleware

**File to modify:** `backend/main.py`

Add a new `RequestLoggingMiddleware` class just below the existing `MetricsMiddleware` class. Pattern mirrors the existing middleware:

```python
_SKIP_LOG_PATHS = {"/health", "/metrics"}

class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.url.path in _SKIP_LOG_PATHS:
            return await call_next(request)
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000
        _log.info(
            "request method=%s path=%s status=%d duration_ms=%.1f",
            request.method, request.url.path, response.status_code, duration_ms,
        )
        return response
```

Register it conditionally after the `MetricsMiddleware` line:

```python
app.add_middleware(MetricsMiddleware)
if app_settings.request_log_enabled:
    app.add_middleware(RequestLoggingMiddleware)
```

**Key pattern:** No request/response body logging -- only method, path, status, duration. This avoids buffering issues and keeps the middleware simple. The existing `MetricsMiddleware` feeds Prometheus; this feeds structured text logs for debugging.

#### Step 3: Add tests

**File to modify:** `backend/tests/test_health.py`

Add tests verifying the middleware logs (check via caplog or by verifying it does not break requests):

```python
class TestRequestLogging:
    def test_health_not_logged(self, client, jwt_headers, caplog):
        """Health endpoint should be skipped by request logging."""
        import logging
        with caplog.at_level(logging.INFO, logger="main"):
            client.get("/health")
        assert not any("request method=GET path=/health" in r.message for r in caplog.records)

    def test_api_request_logged_when_enabled(self, client, jwt_headers, monkeypatch):
        """Normal API endpoints should be logged when enabled."""
        # This test validates the middleware class exists and can dispatch
        from main import RequestLoggingMiddleware
        assert RequestLoggingMiddleware is not None
```

#### Verification

```bash
cd backend && python -m pytest tests/test_health.py -v
```

---

### P2-A3: Graceful Shutdown Handling

**Goal:** Add signal handlers for clean shutdown of (a) the background scheduler thread and (b) Celery workers. Uvicorn already handles SIGTERM via the FastAPI lifespan.

#### Step 1: Add shutdown flag to scheduler

**File to modify:** `backend/scan_engine/scheduler.py`

Add a module-level `_shutdown_requested` `threading.Event` alongside the existing `_scheduler_wake`:

```python
_shutdown_requested = threading.Event()
```

Modify `_background_scheduler()` loop condition from `while True:` to `while not _shutdown_requested.is_set():`. Also use `_shutdown_requested` to break the inner wait:

```python
def _background_scheduler():
    """Runs discovery, link and MAC scans periodically based on app settings."""
    last_discovery = 0
    last_links = 0
    last_macs = 0

    while not _shutdown_requested.is_set():
        _scheduler_wake.wait(timeout=5)
        _scheduler_wake.clear()
        if _shutdown_requested.is_set():
            break
        # ... rest of loop unchanged ...

    _log_event(logging.INFO, "scheduler.shutdown")
```

Add a `shutdown_scheduler()` helper:

```python
def shutdown_scheduler():
    """Signal the background scheduler to exit its loop."""
    _shutdown_requested.set()
    _scheduler_wake.set()  # wake it immediately so it exits
```

#### Step 2: Export new symbols

**File to modify:** `backend/scan_engine/__init__.py`

Add `_shutdown_requested` and `shutdown_scheduler` to the imports and `__all__`.

#### Step 3: Wire shutdown into FastAPI lifespan

**File to modify:** `backend/main.py`

In the `lifespan()` function, add cleanup after the `yield`:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ... existing startup code ...
    yield
    # Shutdown cleanup
    from scan_engine.scheduler import shutdown_scheduler
    _log.info("Shutting down: signaling scheduler to stop")
    shutdown_scheduler()
```

#### Step 4: Add Celery worker shutdown handler

**File to modify:** `backend/celery_app.py`

Add a `worker_shutdown` signal handler at the bottom:

```python
from celery.signals import worker_shutting_down

@worker_shutting_down.connect
def on_worker_shutdown(sig, how, exitcode, **kwargs):
    """Clean up when Celery worker is shutting down."""
    import logging
    logging.getLogger(__name__).info(
        "Celery worker shutting down (signal=%s, how=%s)", sig, how
    )
```

This logs the shutdown event. Celery's built-in `task_acks_late=True` + `worker_prefetch_multiplier=1` already ensures in-flight tasks are re-queued on restart.

#### Step 5: Add tests

**File to modify:** `backend/tests/test_scan_jobs.py` (or new file `backend/tests/test_scheduler.py` if it exists)

Add a test verifying the shutdown mechanism:

```python
class TestSchedulerShutdown:
    def test_shutdown_flag_stops_scheduler(self):
        from scan_engine.scheduler import _shutdown_requested, shutdown_scheduler
        _shutdown_requested.clear()  # reset
        assert not _shutdown_requested.is_set()
        shutdown_scheduler()
        assert _shutdown_requested.is_set()
        _shutdown_requested.clear()  # cleanup
```

#### Verification

```bash
cd backend && python -m pytest tests/test_scan_jobs.py -v -k shutdown
```

---

## Phase P2-B: DevOps

---

### P2-B4: Database Backup/Restore Tooling

**Goal:** Create shell scripts for PostgreSQL backup and restore via Docker exec. Add documentation.

#### Step 1: Create scripts directory

**Directory to create:** `scripts/`

#### Step 2: Create backup script

**File to create:** `scripts/backup.sh`

```bash
#!/usr/bin/env bash
# NetMap PostgreSQL backup script
# Usage: ./scripts/backup.sh [output_dir]
#
# Creates a compressed pg_dump of the netmap database from the running
# postgres container. Output filename includes a UTC timestamp.

set -euo pipefail

CONTAINER="netmap-postgres"
DB_NAME="netmap"
DB_USER="netmap"
OUTPUT_DIR="${1:-./backups}"

mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
FILENAME="netmap_backup_${TIMESTAMP}.sql.gz"
FILEPATH="${OUTPUT_DIR}/${FILENAME}"

echo "[backup] Starting backup of database '${DB_NAME}' from container '${CONTAINER}'..."

docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip > "$FILEPATH"

SIZE=$(du -h "$FILEPATH" | cut -f1)
echo "[backup] Backup complete: ${FILEPATH} (${SIZE})"
```

Key patterns:
- Uses `--clean --if-exists` so the dump can be used for restore (drops objects before recreating)
- Pipes through gzip for compression
- Timestamp in filename prevents overwrites
- `set -euo pipefail` for strict error handling

#### Step 3: Create restore script

**File to create:** `scripts/restore.sh`

```bash
#!/usr/bin/env bash
# NetMap PostgreSQL restore script
# Usage: ./scripts/restore.sh <backup_file.sql.gz>
#
# Restores a compressed pg_dump backup into the running postgres container.
# WARNING: This will overwrite the current database contents.

set -euo pipefail

CONTAINER="netmap-postgres"
DB_NAME="netmap"
DB_USER="netmap"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <backup_file.sql.gz>"
    echo "  Restores a backup file into the running PostgreSQL container."
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "[restore] ERROR: File not found: ${BACKUP_FILE}"
    exit 1
fi

echo "[restore] WARNING: This will overwrite the '${DB_NAME}' database."
read -r -p "[restore] Continue? (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "[restore] Aborted."
    exit 0
fi

echo "[restore] Restoring from ${BACKUP_FILE}..."

gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" --quiet

echo "[restore] Restore complete."
```

Key patterns:
- Requires confirmation before overwriting
- Handles `.sql.gz` files (gzipped dumps)
- Uses `psql` for `--clean` SQL dumps (not `pg_restore` since we use plain SQL format)

#### Step 4: Create documentation

**File to create:** `BACKUP.md`

```markdown
# Database Backup & Restore

## Prerequisites

- Docker is running
- The `netmap-postgres` container is healthy

## Backup

Create a compressed backup of the NetMap database:

    ./scripts/backup.sh [output_directory]

Default output directory: `./backups/`

Example:

    ./scripts/backup.sh
    # Creates: backups/netmap_backup_20260320_143000.sql.gz

    ./scripts/backup.sh /mnt/nas/backups
    # Creates: /mnt/nas/backups/netmap_backup_20260320_143000.sql.gz

## Restore

Restore a backup into the running database:

    ./scripts/restore.sh <backup_file.sql.gz>

Example:

    ./scripts/restore.sh backups/netmap_backup_20260320_143000.sql.gz

The script will ask for confirmation before overwriting the database.

## Automated Backups

To schedule daily backups via cron:

    # Run daily at 2 AM, keep backups in /opt/netmap/backups
    0 2 * * * cd /opt/netmap && ./scripts/backup.sh /opt/netmap/backups

To prune old backups (keep last 30 days):

    find /opt/netmap/backups -name "netmap_backup_*.sql.gz" -mtime +30 -delete

## Notes

- Backups include all data: devices, credentials, audit logs, scan history,
  settings, and user accounts.
- Encrypted SNMP passwords remain encrypted in the backup. The same
  `ENCRYPTION_KEY` must be set when restoring to a new instance.
- Backup file size depends on the number of devices and scan history.
  Typical installations produce backups under 10 MB.
```

#### Step 5: Make scripts executable (noted for implementation)

The implementation step should run:

```bash
chmod +x scripts/backup.sh scripts/restore.sh
```

(On Windows this is a no-op; the scripts are used inside Docker/Linux hosts.)

#### Verification

```bash
# Verify scripts have correct syntax
bash -n scripts/backup.sh && echo "backup.sh OK"
bash -n scripts/restore.sh && echo "restore.sh OK"
```

---

## Phase P2-C: Frontend Features

---

### P2-C5: Frontend Lazy Loading

**Goal:** Wrap page components in `React.lazy()` with `Suspense` fallback. Vite automatically code-splits on dynamic imports.

#### Step 1: Create a loading fallback component

**File to create:** `frontend/src/components/LoadingSpinner.tsx`

```tsx
export default function LoadingSpinner() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100%",
      color: "#64748b",
      fontSize: 13,
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      Loading...
    </div>
  );
}
```

Keep it minimal -- matches existing design tokens (`colors.text.muted`).

#### Step 2: Convert static imports to lazy imports

**File to modify:** `frontend/src/main.tsx`

Replace the 7 static page imports with `React.lazy()`:

```tsx
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import LoadingSpinner from "./components/LoadingSpinner";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const MapPage = lazy(() => import("./pages/MapPage"));
const DevicesPage = lazy(() => import("./pages/DevicesPage"));
const NetworkPage = lazy(() => import("./pages/NetworkPage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
```

Wrap all `<Route>` elements with `<Suspense>`:

```tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route element={<App />}>
            <Route index element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
            <Route path="map" element={<ErrorBoundary><MapPage /></ErrorBoundary>} />
            <Route path="devices" element={<ErrorBoundary><DevicesPage /></ErrorBoundary>} />
            <Route path="network" element={<ErrorBoundary><NetworkPage /></ErrorBoundary>} />
            <Route path="logs" element={<ErrorBoundary><LogsPage /></ErrorBoundary>} />
            <Route path="settings" element={<ErrorBoundary><SettingsPage /></ErrorBoundary>} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>
);
```

#### Step 3: Apply same changes to main.jsx

**File to modify:** `frontend/src/main.jsx`

Apply the identical pattern (without TypeScript `!` assertion). Both files must stay in sync.

#### Step 4: Verify page components use default exports

All page components in `frontend/src/pages/` must use `export default`. Confirm each file has a default export (they currently do based on codebase analysis).

#### Verification

```bash
cd frontend && npx vite build 2>&1 | head -30
# Should show multiple chunk files in the output, one per lazy-loaded page
```

---

### P2-C6: Notification/Toast System

**Goal:** Create a `ToastProvider` context, `useToast` hook, and `Toast` component. Wire up key operations.

#### Step 1: Create toast context and hook

**File to create:** `frontend/src/components/Toast.tsx`

```tsx
import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { colors, radii, fonts } from "../styles/tokens";

// -- Types --

type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  addToast: (type: ToastType, message: string) => void;
}

// -- Context --

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

// -- Color map --

const TYPE_COLORS: Record<ToastType, { bg: string; border: string; text: string }> = {
  success: { bg: "#052e16", border: "#166534", text: "#4ade80" },
  error:   { bg: "#450a0a", border: "#991b1b", text: "#fca5a5" },
  warning: { bg: "#422006", border: "#a16207", text: "#fde68a" },
  info:    { bg: "#0c1929", border: "#1e3a5f", text: "#93c5fd" },
};

const AUTO_DISMISS_MS = 5000;

// -- Provider --

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast container -- bottom-right */}
      <div style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        pointerEvents: "none",
      }}>
        {toasts.map((t) => {
          const c = TYPE_COLORS[t.type];
          return (
            <div key={t.id} style={{
              pointerEvents: "auto",
              padding: "10px 16px",
              borderRadius: radii.md,
              backgroundColor: c.bg,
              border: `1px solid ${c.border}`,
              color: c.text,
              fontSize: 12,
              fontFamily: fonts.base,
              maxWidth: 360,
              cursor: "pointer",
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            }} onClick={() => removeToast(t.id)}>
              {t.message}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
```

Key patterns:
- `ToastProvider` wraps the app and renders a fixed-position container at bottom-right
- `useToast()` returns `{ addToast }` for components to call
- Auto-dismiss after 5 seconds; click to dismiss early
- Uses design tokens from `tokens.ts` for consistent styling
- No external dependencies

#### Step 2: Wrap the app in ToastProvider

**File to modify:** `frontend/src/main.tsx`

Wrap `<BrowserRouter>` with `<ToastProvider>`:

```tsx
import { ToastProvider } from "./components/Toast";

// In the render tree:
<ToastProvider>
  <BrowserRouter>
    ...
  </BrowserRouter>
</ToastProvider>
```

Apply the same change in `frontend/src/main.jsx`.

#### Step 3: Wire up key operations

Integrate toasts into 3-4 high-value locations:

**File to modify:** `frontend/src/pages/SettingsPage.tsx`

After successful settings save operations, add:
```tsx
const { addToast } = useToast();
// On save success:
addToast("success", "Settings saved");
// On save error:
addToast("error", extractErrorMessage(err));
```

**File to modify:** `frontend/src/pages/DevicesPage.tsx`

After scan triggers or bulk operations:
```tsx
addToast("info", "Scan started");
addToast("success", "Import completed successfully");
addToast("error", `Import failed: ${msg}`);
```

**Note:** Only add toasts where inline error/success state (`setError`, `setMsg`) is currently used. Do NOT remove the inline messages -- the toasts supplement them for now. Full migration to toast-only feedback can happen later.

#### Step 4: Add tests

**File to create:** `frontend/src/__tests__/Toast.test.tsx`

```tsx
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider, useToast } from "../components/Toast";

function TestComponent() {
  const { addToast } = useToast();
  return (
    <button onClick={() => addToast("success", "Test message")}>
      Show Toast
    </button>
  );
}

describe("Toast system", () => {
  it("renders toast on addToast call", async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );
    await userEvent.click(screen.getByText("Show Toast"));
    expect(screen.getByText("Test message")).toBeTruthy();
  });

  it("throws when useToast is used outside provider", () => {
    expect(() => {
      render(<TestComponent />);
    }).toThrow("useToast must be used within ToastProvider");
  });
});
```

#### Verification

```bash
cd frontend && npx vitest run src/__tests__/Toast.test.tsx
```

---

### P2-C7: Keyboard Shortcuts

**Goal:** Add a `useKeyboardShortcuts` hook for common actions. Start with navigation and panel close.

#### Step 1: Create the hook

**File to create:** `frontend/src/hooks/useKeyboardShortcuts.ts`

```ts
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

interface ShortcutMap {
  [key: string]: () => void;
}

const NAV_ROUTES = ["/", "/map", "/devices", "/network", "/logs", "/settings"];

export function useKeyboardShortcuts(extraShortcuts?: ShortcutMap) {
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip if user is typing in an input, textarea, or contenteditable
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement).isContentEditable) return;

      // Digit keys 1-6: navigate to pages (no modifiers)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const digit = parseInt(e.key, 10);
        if (digit >= 1 && digit <= NAV_ROUTES.length) {
          e.preventDefault();
          navigate(NAV_ROUTES[digit - 1]);
          return;
        }
      }

      // 's' key: trigger scan (delegate to extra shortcuts)
      // 'Escape': close panel (delegate to extra shortcuts)
      // '?': show help (future)

      if (extraShortcuts && e.key in extraShortcuts) {
        e.preventDefault();
        extraShortcuts[e.key]();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [navigate, extraShortcuts]);
}
```

Key patterns:
- Skips events when user is typing in form fields
- Digit keys 1-6 for page navigation (matches the 6 nav items in `App.tsx`)
- `extraShortcuts` map allows pages to add their own shortcuts (e.g., `Escape` to close a slide-in panel, `s` to start scan)
- No external dependencies

#### Step 2: Wire into App layout

**File to modify:** `frontend/src/App.tsx`

Add the hook call inside the `App` component:

```tsx
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  useKeyboardShortcuts();
  // ... rest of component
```

#### Step 3: Add Escape shortcut to panels

**File to modify:** `frontend/src/components/SwitchDetailSlideIn.tsx`

If the component has an `onClose` prop, pass an Escape handler via `extraShortcuts`:

```tsx
useEffect(() => {
  function handleEsc(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
  document.addEventListener("keydown", handleEsc);
  return () => document.removeEventListener("keydown", handleEsc);
}, [onClose]);
```

(This is a simpler per-component pattern rather than passing through `extraShortcuts`. Each modal/slide-in can handle its own Escape key.)

#### Step 4: Add tests

**File to create:** `frontend/src/__tests__/useKeyboardShortcuts.test.tsx`

```tsx
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

describe("useKeyboardShortcuts", () => {
  beforeEach(() => mockNavigate.mockClear());

  it("navigates to Dashboard on key '1'", () => {
    renderHook(() => useKeyboardShortcuts(), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("navigates to Topology on key '2'", () => {
    renderHook(() => useKeyboardShortcuts(), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    expect(mockNavigate).toHaveBeenCalledWith("/map");
  });

  it("ignores keys when typing in input", () => {
    renderHook(() => useKeyboardShortcuts(), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(mockNavigate).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });
});
```

#### Verification

```bash
cd frontend && npx vitest run src/__tests__/useKeyboardShortcuts.test.tsx
```

---

## Summary of All Files

### Files to Create (6)
| File | Phase |
|------|-------|
| `scripts/backup.sh` | P2-B4 |
| `scripts/restore.sh` | P2-B4 |
| `BACKUP.md` | P2-B4 |
| `frontend/src/components/LoadingSpinner.tsx` | P2-C5 |
| `frontend/src/components/Toast.tsx` | P2-C6 |
| `frontend/src/hooks/useKeyboardShortcuts.ts` | P2-C7 |

### Files to Modify (12)
| File | Phases |
|------|--------|
| `backend/config.py` | P2-A1, P2-A2 |
| `backend/tasks.py` | P2-A1 |
| `backend/celery_app.py` | P2-A1, P2-A3 |
| `backend/routers/audit.py` | P2-A1 |
| `backend/main.py` | P2-A2, P2-A3 |
| `backend/scan_engine/scheduler.py` | P2-A3 |
| `backend/scan_engine/__init__.py` | P2-A3 |
| `frontend/src/main.tsx` | P2-C5, P2-C6 |
| `frontend/src/main.jsx` | P2-C5, P2-C6 |
| `frontend/src/App.tsx` | P2-C7 |
| `frontend/src/components/SwitchDetailSlideIn.tsx` | P2-C7 |
| `frontend/src/pages/SettingsPage.tsx` | P2-C6 |

### Test Files to Create/Modify (4)
| File | Phase |
|------|-------|
| `backend/tests/test_audit.py` (modify -- add purge tests) | P2-A1 |
| `backend/tests/test_health.py` (modify -- add logging tests) | P2-A2 |
| `backend/tests/test_scan_jobs.py` (modify -- add shutdown test) | P2-A3 |
| `frontend/src/__tests__/Toast.test.tsx` (create) | P2-C6 |
| `frontend/src/__tests__/useKeyboardShortcuts.test.tsx` (create) | P2-C7 |

---

## Implementation Order

Execute in this order to minimize conflicts:

1. **P2-A1** -- Audit log retention (self-contained backend change)
2. **P2-A2** -- Request logging middleware (self-contained backend change)
3. **P2-A3** -- Graceful shutdown (touches scheduler + main.py lifespan)
4. **P2-B4** -- Backup/restore scripts (no code changes, just new files)
5. **P2-C5** -- Frontend lazy loading (changes main.tsx/jsx imports)
6. **P2-C6** -- Toast system (adds provider around app in main.tsx/jsx)
7. **P2-C7** -- Keyboard shortcuts (adds hook to App.tsx)

Items 1-4 (backend/devops) and 5-7 (frontend) have no cross-dependencies and could be done in parallel within their group.
