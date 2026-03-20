# Auto-Refresh Bug Analysis

## Reported Issue

Pages seem to auto-refresh, causing new entry/edit forms to close automatically when they open. This happens on Settings page tabs when opening forms.

---

## Investigation Summary

### 1. Polling / Auto-Refresh Mechanisms in the Frontend

| Component | Mechanism | Scope | Impact on Settings |
|---|---|---|---|
| `LogsPage.tsx` | `setInterval` every 5s | Only when LogsPage is active | None -- unmounted when on Settings |
| `ScanSettingsTab.tsx` | `setInterval` 1.5s/2s polling | Only during active scan job | Only affects the Scan tab |
| `DashboardPage.tsx` | WebSocket `scan_complete` handler | Only when DashboardPage is active | None -- unmounted when on Settings |
| `useTopologyData.ts` | One-time fetch on mount (ref-guarded) | Only first mount | None |
| `useScanProgress.ts` | WebSocket, only when `jobId` is non-null | Only in DashboardPage | None |

**Finding**: There is NO periodic auto-refresh mechanism that runs on the Settings page or its tab components.

### 2. Settings Page Re-render Analysis

**SettingsPage.tsx** (lines 27-60): On mount, runs two `useEffect([], [])` hooks:
- `refreshProfiles()` -- fetches `/api/snmp-profiles`
- Fetches `/api/map-background` and `/api/map-settings`

These run ONCE on mount. When the async results arrive, they call `setProfiles(d)`, `setMapBgUrl(...)`, `setMapBgOpacity(...)`, etc. Each state setter causes SettingsPage to re-render. But these are just re-renders, not remounts -- child component state (including open forms) is preserved.

**Tab components** (CredentialsTab, RacksTab, ClassesTab, ModelsTab): Each has:
- `useEffect(() => { refreshAll(); }, [])` -- fetches data on mount only
- `useEffect(() => { if (newEntryTrigger > 0) startNew(); }, [newEntryTrigger])` -- opens form when parent triggers

No tab component has polling, visibility-change handlers, or periodic refetching.

### 3. React.lazy() / Suspense Analysis

In `main.tsx` (lines 31-49):

```tsx
<StrictMode>
  <BrowserRouter>
    <ToastProvider>
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          ...all routes...
        </Routes>
      </Suspense>
    </ToastProvider>
  </BrowserRouter>
</StrictMode>
```

**Findings:**

- **Single Suspense boundary**: One `<Suspense>` wraps ALL routes. If any lazy chunk needs to re-load (browser discards tab memory, chunk eviction), the ENTIRE tree unmounts, showing `<LoadingSpinner />`. When the chunk resolves, everything remounts with default state -- forms would close.
- **Lazy imports are stable**: All `lazy()` calls are at module level (not inside components), so they don't create new references on re-renders. This is correct.
- **StrictMode double-mounting** (dev only): In React 18 dev mode, components mount/unmount/remount, causing effects to run twice. This doubles initial API calls but should not close forms.

### 4. Keyboard Shortcuts -- Potential Root Cause

**useKeyboardShortcuts.ts** (lines 1-44):

```typescript
const ROUTE_MAP: Record<string, string> = {
  "1": "/", "2": "/map", "3": "/devices",
  "4": "/network", "5": "/logs", "6": "/settings",
};

function handler(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  // ... no guard for BUTTON, DIV, or other focusable elements
  const route = ROUTE_MAP[e.key];
  if (route) {
    navigate(route);
  }
}
```

**Issue**: The keyboard shortcut guard ONLY filters `INPUT`, `TEXTAREA`, and `SELECT`. When a user:
1. Clicks "+ New Entry" button (focus is on the button, not an input)
2. The form opens, but focus may still be on the button or a non-input element
3. User presses "s" key --> triggers a scan (which broadcasts state changes via the store)
4. User presses a number key 1-5 --> navigates AWAY from Settings
5. When user comes back, SettingsPage has remounted with default state (form closed)

This is a partial cause -- it requires accidental key presses. However, pressing "s" triggers a scan, and pressing Escape blurs active element. Neither of these should close a form directly.

### 5. Token Refresh --> 401 Redirect Chain

**api.ts** (lines 73-101):

```typescript
export async function refreshTokenIfNeeded(): Promise<void> {
  if (!isTokenExpiringSoon(30)) return;  // 30-minute threshold
  // ... attempts token refresh
}

async function _checkOk(r: Response): Promise<Response> {
  if (r.status === 401) {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_user");
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";  // FULL PAGE RELOAD
    }
  }
}
```

**Issue**: Every API call goes through `refreshTokenIfNeeded()` then `_checkOk()`. If:
1. Token is within 30 minutes of expiry
2. Token refresh endpoint fails or returns an invalid token
3. Subsequent API call gets 401
4. `window.location.href = "/login"` triggers a FULL page reload

This would cause ALL state to be lost. The JWT expiry is 24 hours (config.py: `jwt_expiry_hours: int = 24`), so this only affects the last 30 minutes of a 24-hour session. But when it happens, it manifests as a sudden page reload.

### 6. ToastProvider Context -- Cascading Re-renders

**ToastProvider.tsx** (line 122):

```tsx
<ToastContext.Provider value={{ addToast, removeToast }}>
```

**Issue**: The context value `{{ addToast, removeToast }}` creates a NEW object on every ToastProvider render. While `addToast` and `removeToast` are `useCallback`-wrapped (stable references), the container object is NOT memoized.

When a toast auto-dismisses (5s timer), `ToastProvider` re-renders, creating a new context value. ALL `useToast()` consumers re-render, including `App.tsx`. This causes cascading re-renders through `Outlet` to `SettingsPage`.

**Impact**: These are re-renders, not remounts. Component state is preserved. This alone would NOT close forms, but it adds unnecessary re-render pressure.

### 7. `newEntryTrigger` State Leak Across Tabs

**SettingsPage.tsx** (line 30, 216):

```tsx
const [newEntryTrigger, setNewEntryTrigger] = useState(0);
// ...
<button onClick={() => setNewEntryTrigger(t => t + 1)}>+ New Entry</button>
```

**Tab components** (e.g., RacksTab line 34):

```tsx
useEffect(() => {
  if (newEntryTrigger > 0) { startNew(); }
}, [newEntryTrigger]);
```

**Issue**: `newEntryTrigger` is shared across ALL tabs. When the user clicks "+ New Entry" on one tab (`trigger = 1`), then switches to another tab, the new tab mounts with `trigger = 1`, and its `useEffect` fires `startNew()`, opening a form unexpectedly. This is a separate bug (phantom form opening) but could contribute to user confusion about "auto-refresh."

### 8. Conditional Rendering Pattern

**SettingsPage.tsx** (lines 229-244):

```tsx
{activeTab === "switches" && <CredentialsTabContent ... />}
{activeTab === "racks"    && <RacksTabContent ... />}
// etc.
```

Each tab switch fully unmounts the old tab and mounts the new one from scratch. All local state (forms, edit state, scroll position) is lost on tab switch. This is by design but means ANY mechanism that changes `activeTab` or causes SettingsPage to remount will close forms.

---

## Root Cause Assessment

### Most Likely Cause: Multiple Contributing Factors

No single "smoking gun" periodic auto-refresh was found. Instead, the issue is likely caused by a combination of:

| Priority | Cause | Likelihood | Effect |
|---|---|---|---|
| HIGH | **Token 401 redirect** during API calls | Moderate | Full page reload to /login; ALL state lost |
| HIGH | **Single Suspense boundary** causing full unmount | Moderate | Lazy chunk reload unmounts everything |
| MEDIUM | **Keyboard shortcut accidental navigation** | Moderate | Navigating away remounts SettingsPage |
| MEDIUM | **`newEntryTrigger` leak** across tabs | Confirmed bug | Phantom form opens on tab switch |
| LOW | **Un-memoized ToastProvider context** | Confirmed issue | Cascading re-renders (no state loss) |
| LOW | **StrictMode double-mounting** (dev only) | Dev-only | Double API calls, potential timing issues |
| LOW | **Vite HMR full reload** (dev only) | Dev-only | Full page reload on file save |

### Most Probable Scenario

The most likely cause of the "auto-refresh closing forms" issue is the **token refresh --> 401 redirect chain**. Here's why:

1. When the user is on the Settings page, initial API calls run (e.g., `refreshAll()` in tab components)
2. Each call runs `refreshTokenIfNeeded()` first
3. If the token is expiring soon, a refresh is attempted
4. If refresh fails silently (`if (!r.ok) return;`), the original (soon-to-expire) token is still used
5. If the token expires between the refresh attempt and the actual API call, the API returns 401
6. `_checkOk()` removes tokens from localStorage and sets `window.location.href = "/login"`
7. The full page reload causes all state (including open forms) to be lost
8. If the user had already been redirected to login and logged in again, they'd be back on Settings with no form open

---

## Recommended Fixes

### P0 -- Fix Token Refresh Race Condition
- Add a mutex/lock around `refreshTokenIfNeeded()` so only one refresh runs at a time
- On 401 in `_checkOk()`, attempt ONE token refresh before redirecting to login
- Add a grace period: don't redirect to login on the first 401 -- retry once with a fresh token

### P1 -- Per-Route Suspense Boundaries
- Replace the single `<Suspense>` with per-route boundaries so a lazy chunk reload only affects the route being loaded, not all rendered components

### P2 -- Keyboard Shortcut Guard
- Expand the keyboard shortcut guard to skip ALL keydown events when a modal/form is open (check for a data-attribute on the body or use a context flag)
- Or: only handle keyboard shortcuts when no element is focused (`document.activeElement === document.body`)

### P3 -- Fix `newEntryTrigger` Leak
- Reset `newEntryTrigger` to 0 after the effect fires, or use a callback pattern instead of a counter that persists across tab switches

### P4 -- Memoize ToastProvider Context Value
- Wrap the context value in `useMemo`: `useMemo(() => ({ addToast, removeToast }), [addToast, removeToast])`

### P5 -- Memoize `refreshProfiles` in SettingsPage
- Wrap `refreshProfiles` in `useCallback` to prevent unnecessary prop changes on child components

---

## Files Analyzed

| File | Key Findings |
|---|---|
| `frontend/src/main.tsx` | Single Suspense boundary, StrictMode, lazy imports at module level |
| `frontend/src/App.tsx` | Token check on every render, Outlet renders route children |
| `frontend/src/store.ts` | No polling, stable function references |
| `frontend/src/api.ts` | `refreshTokenIfNeeded` 30-min threshold, `_checkOk` 401 redirect, un-memoized context |
| `frontend/src/hooks/useTopologyData.ts` | One-time fetch, ref-guarded |
| `frontend/src/hooks/useScanProgress.ts` | WebSocket only when jobId non-null |
| `frontend/src/hooks/useKeyboardShortcuts.ts` | Number keys navigate routes, limited guard |
| `frontend/src/pages/SettingsPage.tsx` | No polling, `newEntryTrigger` shared across tabs |
| `frontend/src/components/settings/CredentialsTab.tsx` | One-time fetch, form state local |
| `frontend/src/components/settings/RacksTab.tsx` | One-time fetch, form state local |
| `frontend/src/components/settings/SwitchClassesTab.tsx` | One-time fetch, form state local |
| `frontend/src/components/settings/SwitchModelsTab.tsx` | One-time fetch, form state local |
| `frontend/src/components/settings/ScanSettingsTab.tsx` | Polling only during scan, no effect on other tabs |
| `frontend/src/components/ToastProvider.tsx` | Un-memoized context value |
| `frontend/src/components/ErrorBoundary.tsx` | Standard boundary, no auto-recovery |
| `frontend/nginx.conf` | No auto-refresh headers |
| `backend/config.py` | JWT expiry: 24 hours |
| `backend/scan_engine/scheduler.py` | Links/macs scan every 30s |
| `backend/scan_engine/broadcast.py` | All scan types broadcast scan_complete |
| `backend/routers/ws.py` | WebSocket broadcast to all clients |
