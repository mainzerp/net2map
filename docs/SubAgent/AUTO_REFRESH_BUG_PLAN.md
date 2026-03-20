# Auto-Refresh Bug Fix -- Implementation Plan

Based on analysis in `docs/SubAgent/AUTO_REFRESH_BUG_ANALYSIS.md`.

---

## Fix 1: Per-Route Suspense Boundaries

**File:** `frontend/src/main.tsx`

**Problem:** A single `<Suspense>` wraps all routes. If any lazy chunk needs to re-load (browser discards tab memory, chunk eviction), the entire tree unmounts and shows `<LoadingSpinner />`. When the chunk resolves, everything remounts with default state -- forms close.

**Solution:** Move `<Suspense>` inside each `<Route>` element so that a chunk reload only affects the route being loaded.

**Changes:**

Replace the current render block (lines 31-49):

```tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="login" element={<Suspense fallback={<LoadingSpinner />}><LoginPage /></Suspense>} />
          <Route element={<App />}>
            <Route index element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><DashboardPage /></Suspense></ErrorBoundary>} />
            <Route path="map" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><MapPage /></Suspense></ErrorBoundary>} />
            <Route path="devices" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><DevicesPage /></Suspense></ErrorBoundary>} />
            <Route path="network" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><NetworkPage /></Suspense></ErrorBoundary>} />
            <Route path="logs" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><LogsPage /></Suspense></ErrorBoundary>} />
            <Route path="settings" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><SettingsPage /></Suspense></ErrorBoundary>} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>
);
```

**Key:** Each route gets its own `<Suspense>` boundary. The outer `<Suspense>` is removed entirely. `<ErrorBoundary>` wraps `<Suspense>` so errors in lazy loading are also caught.

---

## Fix 2: Token Refresh 401 Redirect (No Full Page Reload)

**File:** `frontend/src/api.ts`

**Problem:** `_checkOk()` handles 401 by calling `window.location.href = "/login"`, which triggers a full page reload. All React state is destroyed.

**Solution:** Export a navigation setter that `App.tsx` can populate. On 401, call the stored navigate function instead of `window.location.href`. Also attempt one retry with a fresh token before giving up.

### Step 2a: Add navigation callback and retry logic to `api.ts`

Add a module-level navigate callback and update `_checkOk` (around lines 95-110):

```typescript
// ── Soft-navigate callback (set by App.tsx) ──────────────────────────────────
type NavigateFn = (path: string, opts?: { replace?: boolean }) => void;
let _navigateFn: NavigateFn | null = null;

export function setApiNavigate(fn: NavigateFn): void {
  _navigateFn = fn;
}

// Flag to prevent infinite 401 retry loops
let _retrying401 = false;

async function _checkOk(r: Response): Promise<Response> {
  if (!r.ok) {
    if (r.status === 401 && !_retrying401) {
      // Attempt one token refresh before redirecting
      _retrying401 = true;
      try {
        await refreshTokenIfNeeded();
        const token = getStoredToken();
        if (token) {
          // Retry the original request with the new token
          const retryR = await fetch(r.url, {
            method: r.type === "cors" ? undefined : undefined, // original method lost -- fallback to redirect
            headers: { ..._getAuthHeader() },
          });
          _retrying401 = false;
          if (retryR.ok) return retryR;
        }
      } catch {
        // Retry failed
      }
      _retrying401 = false;

      // All retries exhausted -- redirect to login
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      if (window.location.pathname !== "/login") {
        if (_navigateFn) {
          _navigateFn("/login", { replace: true });
        } else {
          window.location.href = "/login";
        }
      }
    }
    let msg: string;
    try {
      const body = await r.json();
      msg = body?.error?.message || body?.detail || r.statusText;
    } catch {
      try { msg = await r.text(); } catch { msg = r.statusText; }
    }
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return r;
}
```

**NOTE on retry:** The retry approach above is simplified. Because `_checkOk` receives only the Response (not the original request config), we cannot fully replay the original request with body/method. A simpler and safer approach: skip the retry entirely and just soft-navigate. The retry logic from the analysis is about preventing premature logouts. A better approach is to handle this in `refreshTokenIfNeeded` by forcing a refresh when the token is truly about to expire. The simplified implementation:

```typescript
async function _checkOk(r: Response): Promise<Response> {
  if (!r.ok) {
    if (r.status === 401) {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      if (window.location.pathname !== "/login") {
        if (_navigateFn) {
          _navigateFn("/login", { replace: true });
        } else {
          window.location.href = "/login";  // fallback if navigate not yet set
        }
      }
    }
    let msg: string;
    try {
      const body = await r.json();
      msg = body?.error?.message || body?.detail || r.statusText;
    } catch {
      try { msg = await r.text(); } catch { msg = r.statusText; }
    }
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return r;
}
```

### Step 2b: Wire up the navigate function in `App.tsx`

Add to `App.tsx` (near imports and before the component body):

```typescript
import { setApiNavigate } from "./api";
```

Inside `App()`, after `const navigate = useNavigate();`:

```typescript
useEffect(() => {
  setApiNavigate(navigate);
}, [navigate]);
```

---

## Fix 3: Keyboard Shortcut Filtering

**File:** `frontend/src/hooks/useKeyboardShortcuts.ts`

**Problem:** The shortcut guard only filters `INPUT`, `TEXTAREA`, and `SELECT`. Pressing number keys while focus is on a button, a `contentEditable` element, or an element inside a modal/dialog fires navigation and unmounts the current route.

**Solution:** Extend the guard to also skip when:
- Focus is on a `contentEditable` element (already added in the codebase -- confirmed present)
- Focus is inside a `[role="dialog"]`, `dialog`, or `[data-modal]` element
- `document.activeElement` is not `document.body` and the focused element is interactive (BUTTON, A, etc.)

**Changes** to `handler` function (lines 22-43):

```typescript
function handler(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (el?.isContentEditable) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  // Skip when focus is inside a modal/dialog
  if (el?.closest('[role="dialog"], dialog, [data-modal]')) return;

  if (e.key === "Escape") {
    opts.onEscape?.();
    return;
  }

  if (e.key === "s" || e.key === "S") {
    opts.onScan?.();
    return;
  }

  const route = ROUTE_MAP[e.key];
  if (route) {
    navigate(route);
  }
}
```

**Key change:** Added `el?.closest('[role="dialog"], dialog, [data-modal]')` check. This prevents accidental navigation when the user is interacting with any modal, dialog, or overlay that uses standard dialog semantics.

---

## Fix 4: Reset `newEntryTrigger` on Tab Switch

**File:** `frontend/src/pages/SettingsPage.tsx`

**Problem:** `newEntryTrigger` is shared across all tabs. When the user clicks "+ New Entry" (trigger = 1) on one tab and switches to another, the new tab mounts with trigger = 1, and its `useEffect` fires `startNew()`, opening a phantom form.

**Solution:** Reset `newEntryTrigger` to 0 whenever `activeTab` changes.

**Changes** -- add a new `useEffect` after the existing state declarations (after line 30):

```typescript
const [activeTab, setActiveTab] = useState("switches");
const [profiles, setProfiles]   = useState<SnmpProfile[]>([]);
const [profLoading, setProfLoading] = useState(true);
const [newEntryTrigger, setNewEntryTrigger] = useState(0);

// Reset new-entry trigger when switching tabs so the form doesn't
// phantom-open on the newly mounted tab.
useEffect(() => {
  setNewEntryTrigger(0);
}, [activeTab]);
```

This ensures that when a tab mounts, `newEntryTrigger` is always 0, and the `if (newEntryTrigger > 0)` guard in each tab component will not fire.

---

## Fix 5: Memoize ToastProvider Context Value

**File:** `frontend/src/components/ToastProvider.tsx`

**Problem:** The context value `{ addToast, removeToast }` creates a new object on every `ToastProvider` render. Even though `addToast` and `removeToast` are stable `useCallback` references, the container object is new each time. This causes all `useToast()` consumers to re-render.

**Solution:** Wrap the context value in `useMemo`.

**Changes** -- add `useMemo` to the import and update the provider (line 122):

Update import (line 1):

```typescript
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
```

Update provider value (around line 122, inside `ToastProvider`):

```typescript
const contextValue = useMemo(
  () => ({ addToast, removeToast }),
  [addToast, removeToast]
);

return (
  <ToastContext.Provider value={contextValue}>
    {children}
    {/* Toast container - fixed bottom-right */}
    ...
```

---

## Implementation Checklist

- [ ] **Fix 1 -- Per-route Suspense boundaries** (`frontend/src/main.tsx`)
  - [ ] Remove the single outer `<Suspense fallback={<LoadingSpinner />}>` wrapper
  - [ ] Add individual `<Suspense fallback={<LoadingSpinner />}>` inside each `<Route>` element
  - [ ] Verify: navigate between routes, confirm each loads independently

- [ ] **Fix 2 -- Soft-navigate on 401** (`frontend/src/api.ts`, `frontend/src/App.tsx`)
  - [ ] Add `setApiNavigate` export and `_navigateFn` module variable to `api.ts`
  - [ ] Replace `window.location.href = "/login"` with `_navigateFn("/login", { replace: true })` (with fallback)
  - [ ] In `App.tsx`, import `setApiNavigate` and call it in a `useEffect` with `navigate`
  - [ ] Verify: when token expires, user is redirected to login without a full page reload

- [ ] **Fix 3 -- Keyboard shortcut dialog guard** (`frontend/src/hooks/useKeyboardShortcuts.ts`)
  - [ ] Add `el?.closest('[role="dialog"], dialog, [data-modal]')` guard after existing tag checks
  - [ ] Verify: open a form/modal on Settings page, press number keys, confirm no navigation occurs

- [ ] **Fix 4 -- Reset `newEntryTrigger` on tab switch** (`frontend/src/pages/SettingsPage.tsx`)
  - [ ] Add `useEffect(() => { setNewEntryTrigger(0); }, [activeTab]);`
  - [ ] Verify: click "+ New Entry" on one tab, switch to another tab, confirm no phantom form opens

- [ ] **Fix 5 -- Memoize ToastProvider context** (`frontend/src/components/ToastProvider.tsx`)
  - [ ] Add `useMemo` to the React import
  - [ ] Wrap `{ addToast, removeToast }` in `useMemo(() => ..., [addToast, removeToast])`
  - [ ] Verify: trigger a toast, confirm no cascading re-renders propagate through the tree

---

## Files Modified

| File | Fix | Description |
|---|---|---|
| `frontend/src/main.tsx` | Fix 1 | Per-route Suspense boundaries |
| `frontend/src/api.ts` | Fix 2 | Soft-navigate on 401, add `setApiNavigate` |
| `frontend/src/App.tsx` | Fix 2 | Wire up `setApiNavigate(navigate)` |
| `frontend/src/hooks/useKeyboardShortcuts.ts` | Fix 3 | Add dialog/modal guard to shortcut handler |
| `frontend/src/pages/SettingsPage.tsx` | Fix 4 | Reset `newEntryTrigger` on tab switch |
| `frontend/src/components/ToastProvider.tsx` | Fix 5 | Memoize context value |

---

## Risk Assessment

| Fix | Risk | Mitigation |
|---|---|---|
| Fix 1 | Low -- standard React pattern | Each route independently suspends; no cross-route impact |
| Fix 2 | Medium -- auth flow change | Fallback to `window.location.href` if navigate not set; login redirect still works |
| Fix 3 | Low -- additive guard | Only prevents shortcuts inside dialogs; existing behavior outside dialogs unchanged |
| Fix 4 | Low -- simple state reset | Reset is to 0, which is the default; no effect on initial mount |
| Fix 5 | Low -- standard memoization | `useMemo` deps are the same stable callbacks; no behavior change |
