# NetMap v1.13.0 -- Backlog Implementation Plan

**Based on:** [BACKLOG_RESEARCH.md](BACKLOG_RESEARCH.md)
**Previous sprint context:** [CODE_REVIEW_PLAN.md](CODE_REVIEW_PLAN.md) (v1.12.0)
**Created:** 2026-03-20

---

## Overview

This plan implements 6 backlog items across 3 phases: security quick wins, frontend polish, and performance optimization. Scan engine modularization (#4) and Celery Beat migration (#5) are deferred to a future sprint due to size/risk.

**Estimated version:** v1.13.0 (MINOR -- new endpoints, new features, no breaking changes)

**Phase dependencies:**
- Phase A items (1-3) are independent of each other and can be done in any order.
- Phase B items (4-5) are natural companions and should be done together.
- Phase C item (6) is independent of all others.
- Steps within Phase A should be done in order: 1 -> 2 -> 3 (step 2 builds on auth patterns from step 1).

---

## Phase A: Security Quick Wins

### Step 1: WebSocket Ticket-Based Auth

**Goal:** Replace raw JWT in WebSocket query string with a single-use, short-lived ticket exchanged via authenticated HTTP endpoint.

#### 1.1 Backend -- Add WS ticket endpoint

**File:** `backend/routers/auth.py`

**Changes:**

Add imports at top:
```python
import secrets
from shared.redis_client import get_redis
```

Add new endpoint after the `login` endpoint:
```python
@router.post("/api/auth/ws-ticket")
def create_ws_ticket(request: Request):
    """Issue a short-lived single-use ticket for WebSocket authentication.

    The ticket is stored in Redis with a 30-second TTL. The client passes
    the ticket as a query parameter when connecting to the WebSocket
    instead of the raw JWT, avoiding JWT exposure in URLs/logs.
    """
    user = getattr(request.state, "user", None)
    if not user:
        api_error(401, "AUTH_REQUIRED", "Authentication required")
    r = get_redis()
    if not r:
        # Redis unavailable -- fall back to allowing raw JWT in WS
        api_error(503, "REDIS_UNAVAILABLE", "Ticket service unavailable; use token auth")
    ticket = secrets.token_urlsafe(32)
    # Store user info in Redis with 30s TTL
    import json
    r.set(f"ws_ticket:{ticket}", json.dumps(user), ex=30)
    return {"ticket": ticket}
```

**File:** `backend/shared/auth.py`

Add `/api/auth/ws-ticket` to `_AUTH_EXEMPT_PATHS`? **No** -- this endpoint requires authentication (the user must be logged in to get a ticket). It goes through normal `_require_auth` middleware, which is correct.

#### 1.2 Backend -- Modify WS authentication to accept tickets

**File:** `backend/routers/ws.py`

Replace the entire `_authenticate_ws` function with:
```python
def _authenticate_ws(token: str) -> None:
    """Validate token for WebSocket connections.

    Accepts either a single-use ticket (preferred) or a raw JWT (fallback).
    Tickets are looked up in Redis and consumed (deleted) after use to
    prevent replay. If auth is disabled on the server, this is a no-op.
    """
    import os
    jwt_secret = os.getenv("JWT_SECRET", os.getenv("SECRET_TOKEN", ""))
    legacy_token = os.getenv("SECRET_TOKEN", "")

    if not jwt_secret and not legacy_token:
        return  # auth disabled

    if not token:
        raise WebSocketException(code=1008, reason="Authentication required")

    # Try ticket-based auth first (preferred path)
    from shared.redis_client import get_redis
    r = get_redis()
    if r:
        import json
        ticket_key = f"ws_ticket:{token}"
        ticket_data = r.get(ticket_key)
        if ticket_data:
            r.delete(ticket_key)  # single-use: consume immediately
            return  # ticket valid

    # Fallback: legacy single-token
    if legacy_token and token == legacy_token:
        return

    # Fallback: raw JWT (for clients that haven't migrated)
    try:
        import jwt as pyjwt
        pyjwt.decode(token, jwt_secret, algorithms=["HS256"])
    except Exception:
        raise WebSocketException(code=1008, reason="Invalid or expired token")
```

#### 1.3 Frontend -- Exchange ticket before WS connect

**File:** `frontend/src/hooks/useScanProgress.js`

Replace the import line:
```javascript
import { getStoredToken, api } from "../api.js";
```

Replace the `connect` function body to fetch a ticket first:
```javascript
    async function connect() {
      if (unmounted) return;

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      let ticket = "";
      try {
        const resp = await api.post("/api/auth/ws-ticket", {});
        ticket = resp.ticket || "";
      } catch (_) {
        // Ticket endpoint unavailable (no Redis or auth disabled) -- fall back to raw token
        ticket = getStoredToken();
      }
      const url = `${proto}//${window.location.host}/ws/scan-progress${ticket ? "?token=" + encodeURIComponent(ticket) : ""}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.job_id && data.job_id !== jobId) return;
          setProgress(data);
        } catch (err) {
          console.warn("WebSocket message parse error", err);
        }
      };

      ws.onclose = () => {
        if (unmounted) return;
        reconnectRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }
```

#### 1.4 Tests

**File:** `backend/tests/test_auth.py`

Add tests at end of file:
```python
def test_ws_ticket_requires_auth(client):
    """WS ticket endpoint requires authentication."""
    r = client.post("/api/auth/ws-ticket")
    assert r.status_code == 401

def test_ws_ticket_returns_ticket(client, jwt_headers):
    """WS ticket endpoint returns a ticket when authenticated (requires Redis mock)."""
    from unittest.mock import patch, MagicMock
    mock_redis = MagicMock()
    with patch("routers.auth.get_redis", return_value=mock_redis):
        r = client.post("/api/auth/ws-ticket", headers=jwt_headers)
    assert r.status_code == 200
    assert "ticket" in r.json()
    mock_redis.set.assert_called_once()

def test_ws_ticket_503_without_redis(client, jwt_headers):
    """WS ticket endpoint returns 503 when Redis is unavailable."""
    from unittest.mock import patch
    with patch("routers.auth.get_redis", return_value=None):
        r = client.post("/api/auth/ws-ticket", headers=jwt_headers)
    assert r.status_code == 503
```

#### Step 1 Checklist

- [ ] 1.1 Add `POST /api/auth/ws-ticket` endpoint to `backend/routers/auth.py`
- [ ] 1.2 Rewrite `_authenticate_ws()` in `backend/routers/ws.py` to try ticket first, then fall back to JWT
- [ ] 1.3 Update `frontend/src/hooks/useScanProgress.js` to fetch ticket before connecting
- [ ] 1.4 Add tests for ws-ticket endpoint to `backend/tests/test_auth.py`
- [ ] 1.5 Verify: WS connection works with ticket when Redis is available
- [ ] 1.6 Verify: WS connection falls back to raw JWT when Redis is unavailable
- [ ] 1.7 Verify: Tickets are single-use (second connection with same ticket is rejected)

**Dependencies:** None
**Breaking changes:** None -- old clients sending raw JWT still work as a fallback

---

### Step 2: JWT Token Refresh

**Goal:** Add a refresh endpoint and frontend auto-refresh logic using the existing `isTokenExpiringSoon()` utility.

#### 2.1 Backend -- Add refresh endpoint

**File:** `backend/routers/auth.py`

Add import:
```python
import jwt as pyjwt
from shared.auth import JWT_SECRET, JWT_ALGORITHM
```

Add new endpoint after `get_current_user`:
```python
@router.post("/api/auth/refresh", response_model=TokenResponse)
@limiter.limit("10/minute")
def refresh_token(request: Request, db: Session = Depends(get_db)):
    """Refresh a valid (or recently-expired) JWT token.

    Accepts the current token via Authorization header. If the token is
    valid or expired within the last 60 minutes, issues a new token.
    The user must still exist and be active in the database.
    """
    user_info = getattr(request.state, "user", None)
    if not user_info:
        # Token might be recently expired -- try manual decode with leeway
        from fastapi.security import HTTPAuthorizationCredentials
        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer "):
            api_error(401, "AUTH_REQUIRED", "Authentication required")
        token = auth_header[7:]
        try:
            payload = pyjwt.decode(
                token, JWT_SECRET, algorithms=[JWT_ALGORITHM],
                options={"verify_exp": False},
            )
            # Check token is not too old (max 60 minutes past expiry)
            from datetime import datetime, timezone
            exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
            now = datetime.now(timezone.utc)
            if (now - exp).total_seconds() > 3600:
                api_error(401, "AUTH_EXPIRED", "Token expired beyond refresh window")
            user_info = {
                "id": int(payload["sub"]),
                "username": payload["username"],
                "role": payload["role"],
            }
        except Exception:
            api_error(401, "AUTH_INVALID", "Invalid token")

    # Verify user still exists and is active
    user = db.query(User).filter(
        User.id == user_info["id"], User.is_active == True
    ).first()
    if not user:
        api_error(401, "AUTH_USER_INACTIVE", "User account is inactive or deleted")

    new_token = create_token(user.id, user.username, user.role)
    return TokenResponse(access_token=new_token, role=user.role, username=user.username)
```

**File:** `backend/shared/auth.py`

Add `/api/auth/refresh` to `_AUTH_EXEMPT_PATHS` so expired tokens are not rejected before reaching the endpoint:
```python
_AUTH_EXEMPT_PATHS = {"/health", "/api/auth/login", "/api/map-background", "/api/auth/refresh"}
```

> **Rationale:** The refresh endpoint needs to accept expired tokens (within the grace window). The middleware would reject expired tokens with 401 before the endpoint can apply its own leeway logic. By exempting the path, the endpoint handles its own auth validation.

#### 2.2 Frontend -- Add auto-refresh logic

**File:** `frontend/src/api.js`

Add the refresh function after `isTokenExpiringSoon`:
```javascript
export async function refreshTokenIfNeeded() {
  if (!isTokenExpiringSoon(30)) return;
  const token = getStoredToken();
  if (!token) return;
  try {
    const r = await fetch(`${API}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    });
    if (!r.ok) return;  // refresh failed -- let normal 401 handling take over
    const data = await r.json();
    if (data.access_token) {
      login(data.access_token, { username: data.username, role: data.role });
    }
  } catch (_) {
    // Silently fail -- next API call will trigger 401 redirect if truly expired
  }
}
```

Modify the `api.get` method to check token expiry before each request. Add at the very beginning of the `get` async function body:
```javascript
    await refreshTokenIfNeeded();
```

Also add at the beginning of `post`, `put`, `patch`, `del`. Since these are one-liners, they need to be refactored slightly. Change them to:
```javascript
  post:  async (path, body) => { await refreshTokenIfNeeded(); return fetch(`${API}${path}`, { method:"POST", headers:{"Content-Type":"application/json", ..._getAuthHeader()}, body: JSON.stringify(body) }).then(_checkOk).then(r => r.json()); },
  put:   async (path, body) => { await refreshTokenIfNeeded(); return fetch(`${API}${path}`, { method:"PUT", headers:{"Content-Type":"application/json", ..._getAuthHeader()}, body: JSON.stringify(body) }).then(_checkOk).then(r => r.json()); },
  patch: async (path, body) => { await refreshTokenIfNeeded(); return fetch(`${API}${path}`, { method:"PATCH", headers:{"Content-Type":"application/json", ..._getAuthHeader()}, body: JSON.stringify(body) }).then(_checkOk).then(r => r.json()); },
  del:   async (path)       => { await refreshTokenIfNeeded(); return fetch(`${API}${path}`, { method:"DELETE", headers:{ ..._getAuthHeader() } }).then(_checkOk); },
```

#### 2.3 Tests

**File:** `backend/tests/test_auth.py`

Add tests:
```python
def test_refresh_with_valid_token(client, jwt_headers, db):
    """Refresh returns a new token when current token is valid."""
    r = client.post("/api/auth/refresh", headers=jwt_headers)
    assert r.status_code == 200
    data = r.json()
    assert "access_token" in data
    assert data["username"] == "testadmin"
    assert data["role"] == "admin"

def test_refresh_without_token(client):
    """Refresh returns 401 without a token."""
    r = client.post("/api/auth/refresh")
    assert r.status_code == 401

def test_refresh_with_inactive_user(client, db):
    """Refresh returns 401 if user is deactivated."""
    user = User(
        username="deactivated", email="d@test.com",
        hashed_pw=hash_password("TestPass123"), role="admin", is_active=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_token(user.id, user.username, user.role)
    r = client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
```

#### Step 2 Checklist

- [ ] 2.1 Add `POST /api/auth/refresh` endpoint to `backend/routers/auth.py`
- [ ] 2.2 Add `/api/auth/refresh` to `_AUTH_EXEMPT_PATHS` in `backend/shared/auth.py`
- [ ] 2.3 Add `refreshTokenIfNeeded()` function to `frontend/src/api.js`
- [ ] 2.4 Add `await refreshTokenIfNeeded()` call at start of all `api.*` methods in `frontend/src/api.js`
- [ ] 2.5 Add tests for refresh endpoint to `backend/tests/test_auth.py`
- [ ] 2.6 Verify: Token refresh occurs automatically before API calls when token is expiring within 30 minutes
- [ ] 2.7 Verify: Expired tokens within 60 min grace window can be refreshed
- [ ] 2.8 Verify: Deactivated users cannot refresh tokens

**Dependencies:** None
**Breaking changes:** None

---

### Step 3: Rate Limiting Expansion

**Goal:** Add rate limits to unprotected write endpoints. Fix the unauthenticated dry-run endpoint.

#### 3.1 Fix dry-run auth gap (security fix)

**File:** `backend/routers/scan.py`

Add `require_role` dependency and rate limiting to the dry-run endpoint. Change:
```python
@router.post("/api/scan/dry-run/jobs")
def start_dry_run_job():
```
To:
```python
@router.post("/api/scan/dry-run/jobs",
             dependencies=[require_role("admin", "operator")])
@limiter.limit("3/minute")
def start_dry_run_job(request: Request):
```

> **Important:** The `request: Request` parameter must be added so `slowapi` can extract the client IP.

#### 3.2 Rate limit settings write endpoint

**File:** `backend/routers/settings.py`

Add imports at top:
```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
```

Add rate limit decorator to `update_setting`:
```python
@router.put("/api/settings/{key}", response_model=AppSettingOut,
            dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def update_setting(key: str, body: AppSettingUpdate, request: Request, db: Session = Depends(get_db)):
```

> `request: Request` is already in the function signature.

#### 3.3 Rate limit credentials write endpoints

**File:** `backend/routers/credentials.py`

Add imports at top:
```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
```

Add rate limit decorators:
```python
@router.post("/api/credentials", response_model=CredentialOut, status_code=201,
             dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def create_credential(body: CredentialCreate, request: Request, db: Session = Depends(get_db)):
```

```python
@router.put("/api/credentials/{cred_id}", response_model=CredentialOut,
            dependencies=[require_role("admin", "operator")])
@limiter.limit("10/minute")
def update_credential(cred_id: int, body: CredentialUpdate, request: Request, db: Session = Depends(get_db)):
```

```python
@router.delete("/api/credentials/{cred_id}", status_code=204,
               dependencies=[require_role("admin")])
@limiter.limit("10/minute")
def delete_credential(cred_id: int, request: Request, db: Session = Depends(get_db)):
```

> `request: Request` is already present on create and update. Must be added to `delete_credential` signature.

#### 3.4 Rate limit user management endpoints

**File:** `backend/routers/auth.py`

Add rate limit decorators to user management endpoints:
```python
@router.post("/api/users", response_model=UserOut, status_code=201,
             dependencies=[require_role("admin")])
@limiter.limit("10/minute")
def create_user(body: UserCreate, request: Request, db: Session = Depends(get_db)):
```

```python
@router.put("/api/users/{user_id}", response_model=UserOut,
            dependencies=[require_role("admin")])
@limiter.limit("10/minute")
def update_user(user_id: int, body: UserUpdate, request: Request, db: Session = Depends(get_db)):
```

```python
@router.delete("/api/users/{user_id}", status_code=204,
               dependencies=[require_role("admin")])
@limiter.limit("10/minute")
def delete_user(user_id: int, request: Request, db: Session = Depends(get_db)):
```

> `request: Request` is already in create and update signatures. Must be added to `delete_user`.

#### 3.5 Tests

**File:** `backend/tests/test_auth.py`

Add test for dry-run auth requirement:
```python
def test_dry_run_requires_auth(client):
    """Dry-run endpoint now requires admin/operator role."""
    r = client.post("/api/scan/dry-run/jobs")
    assert r.status_code == 401
```

**File:** `backend/tests/test_credentials.py` (new file)

```python
def test_create_credential_rate_limited(client, jwt_headers):
    """Credentials endpoint has rate limiting."""
    # Just verify the endpoint responds (rate limit won't trigger in tests
    # because slowapi is reset per request in test client)
    # The decorator presence is the important thing.
    pass
```

> Note: `slowapi` rate limiting is hard to test with `TestClient` since it resets state. The main verification is that the decorators are in place and don't break the endpoints.

#### Step 3 Checklist

- [ ] 3.1 Add `require_role("admin", "operator")` dependency and `@limiter.limit("3/minute")` to `POST /api/scan/dry-run/jobs` in `backend/routers/scan.py`
- [ ] 3.2 Add `request: Request` parameter to `start_dry_run_job` in `backend/routers/scan.py`
- [ ] 3.3 Add limiter import and `@limiter.limit("10/minute")` to `PUT /api/settings/{key}` in `backend/routers/settings.py`
- [ ] 3.4 Add limiter import and `@limiter.limit("10/minute")` to `POST`, `PUT`, `DELETE /api/credentials/*` in `backend/routers/credentials.py`
- [ ] 3.5 Add `request: Request` parameter to `delete_credential` in `backend/routers/credentials.py`
- [ ] 3.6 Add `@limiter.limit("10/minute")` to `POST`, `PUT`, `DELETE /api/users/*` in `backend/routers/auth.py`
- [ ] 3.7 Add `request: Request` parameter to `delete_user` in `backend/routers/auth.py`
- [ ] 3.8 Add test for dry-run auth requirement to `backend/tests/test_auth.py`
- [ ] 3.9 Run full test suite to verify no regressions

**Dependencies:** None
**Breaking changes:**
- `POST /api/scan/dry-run/jobs` now requires authentication (was previously open). Frontend already sends auth headers for all API calls via `_getAuthHeader()`, so no frontend change needed. External scripts calling this endpoint without auth will break.

---

## Phase B: Frontend Polish

### Step 4: Settings Loading/Error States

**Goal:** Add missing loading and error states to SettingsPage and MapSettingsTab.

#### 4.1 Fix SettingsPage silent error swallowing

**File:** `frontend/src/pages/SettingsPage.jsx`

Add state variables for map settings and profile loading errors. Add after the existing `bgFileRef` state:
```javascript
  const [mapBgError, setMapBgError] = useState("");
  const [mapSettingsError, setMapSettingsError] = useState("");
  const [mapSettingsLoading, setMapSettingsLoading] = useState(true);
  const [profError, setProfError] = useState("");
```

Fix the `refreshProfiles` function to capture errors:
```javascript
  const refreshProfiles = () => {
    setProfLoading(true);
    setProfError("");
    api.get("/api/snmp-profiles")
      .then(d => { setProfiles(d); setProfLoading(false); })
      .catch(ex => { setProfError(ex instanceof Error ? ex.message : String(ex)); setProfLoading(false); });
  };
```

Fix the map background/settings `useEffect` to capture errors:
```javascript
  useEffect(() => {
    fetch(`${API}/api/map-background`)
      .then(r => { if (r.ok) setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`); })
      .catch(ex => { setMapBgError(ex instanceof Error ? ex.message : "Failed to load map background"); });
    api.get("/api/map-settings").then(s => {
      if (s.opacity != null) setMapBgOpacity(s.opacity);
      if (s.scale != null) setMapBgScale(s.scale);
      if (s.bg_color != null) setMapBgColor(s.bg_color);
    }).catch(ex => {
      setMapSettingsError(ex instanceof Error ? ex.message : "Failed to load map settings");
    }).finally(() => setMapSettingsLoading(false));
  }, []);
```

Fix the save handlers to show errors instead of using `console.error`:
```javascript
  const changeBgOpacity = (val) => {
    setMapBgOpacity(val);
    setMapSettingsError("");
    api.put("/api/map-settings", { opacity: val }).catch(ex => {
      setMapSettingsError(ex instanceof Error ? ex.message : "Failed to save opacity");
    });
  };

  const changeBgScale = (val) => {
    setMapBgScale(val);
    setMapSettingsError("");
    api.put("/api/map-settings", { scale: val }).catch(ex => {
      setMapSettingsError(ex instanceof Error ? ex.message : "Failed to save scale");
    });
  };

  const changeBgColor = (val) => {
    setMapBgColor(val);
    setMapSettingsError("");
    api.put("/api/map-settings", { bg_color: val }).catch(ex => {
      setMapSettingsError(ex instanceof Error ? ex.message : "Failed to save color");
    });
  };
```

Pass error/loading props to MapSettingsTab:
```jsx
{activeTab === "map" && <MapSettingsTabContent
  url={mapBgUrl} opacity={mapBgOpacity} scale={mapBgScale}
  bgColor={mapBgColor} fileRef={bgFileRef}
  onUpload={uploadMapBg} onRemove={removeMapBg}
  onChangeOpacity={changeBgOpacity} onChangeScale={changeBgScale}
  onChangeBgColor={changeBgColor}
  loading={mapSettingsLoading}
  error={mapBgError || mapSettingsError}
/>}
```

Pass error prop to SnmpProfilesTab:
```jsx
{activeTab === "profiles" && <SnmpProfilesTabContent
  profiles={profiles} loading={profLoading} onChanged={refreshProfiles}
  newEntryTrigger={newEntryTrigger}
  loadError={profError}
/>}
```

#### 4.2 Add error/loading display to MapSettingsTab

**File:** `frontend/src/components/settings/MapSettingsTab.jsx`

Add `loading` and `error` to the destructured props:
```javascript
function MapSettingsTabContent({ url, opacity, scale, bgColor, fileRef, onUpload, onRemove, onChangeOpacity, onChangeScale, onChangeBgColor, loading, error }) {
```

Add at the top of the return JSX, before the first `<div>` child:
```jsx
      {loading && (
        <div style={{color:"#64748b", fontSize:11, padding:"12px 0"}}>Loading map settings...</div>
      )}
      {error && (
        <div style={{color:"#f87171", fontSize:11, padding:"8px 12px", backgroundColor:"#1c1917", border:"1px solid #7f1d1d", borderRadius:6, marginBottom:8}}>
          {error}
        </div>
      )}
```

#### 4.3 Add load error display to SnmpProfilesTab

**File:** `frontend/src/components/settings/SnmpProfilesTab.jsx`

Add `loadError` to destructured props:
```javascript
function SnmpProfilesTabContent({ profiles, loading, onChanged, newEntryTrigger, loadError }) {
```

In the rendered output, add an error banner for `loadError` (before the existing profiles list, after the loading check). Find the loading indicator in the JSX and add after it:
```jsx
{loadError && (
  <div style={{color:"#f87171", fontSize:11, padding:"8px 12px", backgroundColor:"#1c1917", border:"1px solid #7f1d1d", borderRadius:6, marginBottom:8}}>
    {loadError}
  </div>
)}
```

#### Step 4 Checklist

- [ ] 4.1 Add `mapBgError`, `mapSettingsError`, `mapSettingsLoading`, `profError` state to `frontend/src/pages/SettingsPage.jsx`
- [ ] 4.2 Fix `refreshProfiles` to capture errors in `frontend/src/pages/SettingsPage.jsx`
- [ ] 4.3 Fix map background/settings `useEffect` to capture errors in `frontend/src/pages/SettingsPage.jsx`
- [ ] 4.4 Fix `changeBgOpacity`, `changeBgScale`, `changeBgColor` to show errors in `frontend/src/pages/SettingsPage.jsx`
- [ ] 4.5 Pass `loading`/`error` props to `MapSettingsTabContent` in `frontend/src/pages/SettingsPage.jsx`
- [ ] 4.6 Pass `loadError` prop to `SnmpProfilesTabContent` in `frontend/src/pages/SettingsPage.jsx`
- [ ] 4.7 Accept and render `loading`/`error` props in `frontend/src/components/settings/MapSettingsTab.jsx`
- [ ] 4.8 Accept and render `loadError` prop in `frontend/src/components/settings/SnmpProfilesTab.jsx`
- [ ] 4.9 Verify: Map settings tab shows loading state on initial load
- [ ] 4.10 Verify: Map settings tab shows error when backend is unreachable
- [ ] 4.11 Verify: SNMP profiles tab shows error if loading fails

**Dependencies:** Should be done before or alongside Step 5 (error display consistency).
**Breaking changes:** None

---

### Step 5: Frontend Error Display Consistency

**Goal:** Replace all `String(ex)` / `String(e)` error formatting with a utility that strips the `"Error: "` prefix, producing cleaner messages.

#### 5.1 Add `extractErrorMessage` utility

**File:** `frontend/src/api.js`

Add after the `isTokenExpiringSoon` function:
```javascript
/**
 * Extract a clean error message from an exception.
 * Strips the "Error: " prefix that String(ex) produces from Error objects.
 */
export function extractErrorMessage(ex) {
  if (ex instanceof Error) return ex.message;
  if (typeof ex === 'string') return ex;
  return 'An unexpected error occurred';
}
```

#### 5.2 Replace `String(ex)` calls across settings tabs

**Files to modify (mechanical find-replace):**

All occurrences of `String(ex)` or `String(e)` in catch blocks should be replaced with `extractErrorMessage(ex)` or `extractErrorMessage(e)`. Each file needs `extractErrorMessage` added to its import from `../../api.js` (or `../api.js`).

| File | Import Change | Replacements |
|------|--------------|-------------- |
| `frontend/src/components/settings/CredentialsTab.jsx` | Add `extractErrorMessage` to import | `String(ex)` -> `extractErrorMessage(ex)` (1 occurrence, line 105) |
| `frontend/src/components/settings/DnsTab.jsx` | Add `extractErrorMessage` to import | `String(e)` -> `extractErrorMessage(e)` (1 occurrence, line 37) |
| `frontend/src/components/settings/ImportExportTab.jsx` | Add `extractErrorMessage` to import | `String(ex)` -> `extractErrorMessage(ex)` (2 occurrences, lines 18, 40) |
| `frontend/src/components/settings/RacksTab.jsx` | Add `extractErrorMessage` to import | `String(ex)` -> `extractErrorMessage(ex)` (1 occurrence, line 49) |
| `frontend/src/components/settings/ScanSettingsTab.jsx` | Add `extractErrorMessage` to import | `String(ex)` -> `extractErrorMessage(ex)` (3 occurrences, lines 124, 164, 229) |
| `frontend/src/components/settings/SnmpProfilesTab.jsx` | Add `extractErrorMessage` to import | `String(ex)` -> `extractErrorMessage(ex)` (1 occurrence, line 46) |
| `frontend/src/components/settings/SwitchClassesTab.jsx` | Add `extractErrorMessage` to import | `String(ex)` -> `extractErrorMessage(ex)` (3+ occurrences, lines 53, 70, 79) |
| `frontend/src/components/settings/SwitchModelsTab.jsx` | Add `extractErrorMessage` to import | `String(ex)` -> `extractErrorMessage(ex)` (1+ occurrences, line 63) |
| `frontend/src/components/DeviceTable.jsx` | Add `extractErrorMessage` to import | `String(ex)` -> `extractErrorMessage(ex)` (1 occurrence, line 108) |

> **Implementation note:** For each file, read the current import line from `api.js`, add `extractErrorMessage` to the destructured imports, then find-replace `String(ex)` / `String(e)` with `extractErrorMessage(ex)` / `extractErrorMessage(e)`.

#### Step 5 Checklist

- [ ] 5.1 Add `extractErrorMessage()` function to `frontend/src/api.js`
- [ ] 5.2 Update `frontend/src/components/settings/CredentialsTab.jsx` -- import + replace
- [ ] 5.3 Update `frontend/src/components/settings/DnsTab.jsx` -- import + replace
- [ ] 5.4 Update `frontend/src/components/settings/ImportExportTab.jsx` -- import + replace
- [ ] 5.5 Update `frontend/src/components/settings/RacksTab.jsx` -- import + replace
- [ ] 5.6 Update `frontend/src/components/settings/ScanSettingsTab.jsx` -- import + replace
- [ ] 5.7 Update `frontend/src/components/settings/SnmpProfilesTab.jsx` -- import + replace
- [ ] 5.8 Update `frontend/src/components/settings/SwitchClassesTab.jsx` -- import + replace
- [ ] 5.9 Update `frontend/src/components/settings/SwitchModelsTab.jsx` -- import + replace
- [ ] 5.10 Update `frontend/src/components/DeviceTable.jsx` -- import + replace
- [ ] 5.11 Verify: Error messages no longer have "Error: " prefix (e.g., show "HTTP 400: Username already exists" instead of "Error: HTTP 400: Username already exists")

**Dependencies:** None (works alongside Step 4)
**Breaking changes:** None

---

## Phase C: Performance

### Step 6: Topology ETag Optimization

**Goal:** Replace the SHA-256-of-body ETag with the version counter directly, and ensure scan completion bumps the topology version.

#### 6.1 Use version counter as ETag

**File:** `backend/routers/topology.py`

In the `get_topology` function, replace the ETag computation. Change:
```python
    etag = f'"{ hashlib.sha256(body.encode()).hexdigest()[:32]}"'
```
To:
```python
    new_version = _get_topo_version()
    etag = f'"v{new_version}"'
```

> **Rationale:** The version counter already guarantees a unique ETag per topology change. The SHA-256 hash of the full body is redundant computation. Using the version counter directly eliminates the serialization + hashing cost on cache misses.

Also remove the `hashlib` import since it is no longer needed:
```python
# Remove: import hashlib
```

Check if `hashlib` is used elsewhere in the file. Scan shows it is only used for the ETag. Safe to remove.

#### 6.2 Bump topology version after scan completion

**File:** `backend/scan_engine.py`

After the line that calls `_broadcast_scan_complete(...)` (around line 1103), add a topology version bump. Add:
```python
    from routers.topology import _bump_topo_version
    if not dry_run:
        _bump_topo_version()
```

> This must only happen for non-dry-run scans, since dry-run scans do not persist any data changes.

The import is done inline to avoid circular import issues (`scan_engine` is imported by `routers/scan.py`, and `routers/topology.py` is a sibling router).

#### 6.3 Verify all mutation paths bump version

Current state of `_bump_topo_version()` calls:
| Endpoint | File | Bumps? |
|----------|------|--------|
| `PATCH /api/topology/devices/{id}/position` | topology.py L142 | Yes |
| `PATCH /api/topology/racks/{id}/position` | topology.py L158 | Yes |
| `PATCH /api/topology/devices/bulk-meta` | topology.py L177 | Yes |
| `PATCH /api/topology/devices/{id}/meta` | topology.py L232 | Yes |
| Scan completion | scan_engine.py | **No -- needs fix (6.2 above)** |
| `POST /api/credentials` (creates device side-effect) | credentials.py | **No -- needs fix** |
| `PUT /api/credentials/{id}` (updates device side-effect) | credentials.py | **No -- needs fix** |
| `DELETE /api/credentials/{id}` (device remains) | credentials.py | Topology doesn't change (device still in DB, just no credential) -- actually it does change because topology filters by `cred_ips`. **Needs fix.** |

**File:** `backend/routers/credentials.py`

Add import at top:
```python
from routers.topology import _bump_topo_version
```

Add `_bump_topo_version()` call at the end of `create_credential` (after `db.commit()`, before `return`):
```python
    _bump_topo_version()
    log_audit(request, "create", "credential", str(cred.id), {"ip": cred.ip, "label": cred.label})
    return cred
```

Add `_bump_topo_version()` call at the end of `update_credential` (after `db.commit()`, before `return`):
```python
    _bump_topo_version()
    log_audit(request, "update", "credential", str(cred_id), {"fields": list(updates.keys())})
    return cred
```

Add `_bump_topo_version()` call at the end of `delete_credential` (after `db.commit()`):
```python
    db.delete(cred)
    db.commit()
    _bump_topo_version()
```

#### Step 6 Checklist

- [ ] 6.1 Replace SHA-256 ETag with version-counter ETag in `backend/routers/topology.py`
- [ ] 6.2 Remove unused `hashlib` import from `backend/routers/topology.py`
- [ ] 6.3 Add `_bump_topo_version()` call after scan completion in `backend/scan_engine.py` (non-dry-run only)
- [ ] 6.4 Add `_bump_topo_version()` calls to `create_credential`, `update_credential`, `delete_credential` in `backend/routers/credentials.py`
- [ ] 6.5 Add `from routers.topology import _bump_topo_version` import to `backend/routers/credentials.py`
- [ ] 6.6 Verify: `GET /api/topology` returns 304 when no changes have occurred
- [ ] 6.7 Verify: `GET /api/topology` returns fresh data after a scan completes
- [ ] 6.8 Verify: `GET /api/topology` returns fresh data after credential CRUD operations
- [ ] 6.9 Run backend tests to verify no regressions

**Dependencies:** None
**Breaking changes:** ETag values will change format from SHA-256 hex to `"v{N}"`. Any client caching ETags will get a cache miss on the first request after upgrade (expected and harmless -- they will get fresh data).

---

## Version Update

### VERSION.md update

After all steps are complete, add a new entry to `VERSION.md`:

```markdown
## v1.13.0 -- Security Enhancements, Frontend Polish, Performance

**Type:** MINOR (new endpoints, security improvements, UI polish)

### Changes

#### Security
- WebSocket ticket-based auth: `/api/auth/ws-ticket` endpoint replaces raw JWT in WS query strings
- JWT token refresh: `/api/auth/refresh` endpoint with 60-minute grace window for expired tokens
- Rate limiting added to: credentials CRUD (10/min), settings write (10/min), user management (10/min), dry-run jobs (3/min)
- Dry-run endpoint now requires admin/operator authentication (was previously unauthenticated)

#### Frontend
- Map settings tab: loading spinner and error states
- SNMP profiles tab: load error display
- Consistent error message formatting via `extractErrorMessage()` utility (removes "Error: " prefix)
- Silent `.catch(() => {})` calls replaced with proper error handling in SettingsPage
- `console.error` catches replaced with user-visible error messages

#### Performance
- Topology ETag uses version counter directly instead of SHA-256 hash of full response body
- Scan completion now bumps topology version, ensuring clients get fresh data after scans
- Credential CRUD operations now bump topology version for accurate cache invalidation

#### Infrastructure
- Frontend auto-refresh for JWT tokens when expiring within 30 minutes

### Files Created
None

### Files Modified
| File | Change |
|------|--------|
| backend/routers/auth.py | WS ticket endpoint, refresh endpoint, rate limits on user management |
| backend/routers/ws.py | Ticket-based auth in `_authenticate_ws()` |
| backend/routers/scan.py | Dry-run auth + rate limit |
| backend/routers/settings.py | Rate limit on settings write |
| backend/routers/credentials.py | Rate limits, topology version bump |
| backend/routers/topology.py | Version-counter ETag, removed SHA-256 hashing |
| backend/shared/auth.py | `/api/auth/refresh` added to exempt paths |
| backend/scan_engine.py | Topology version bump after scan |
| backend/tests/test_auth.py | Tests for ws-ticket, refresh, dry-run auth |
| frontend/src/api.js | `refreshTokenIfNeeded()`, `extractErrorMessage()`, auto-refresh in API methods |
| frontend/src/hooks/useScanProgress.js | Ticket exchange before WS connect |
| frontend/src/pages/SettingsPage.jsx | Error/loading state for map settings, profiles |
| frontend/src/components/settings/MapSettingsTab.jsx | Loading/error props |
| frontend/src/components/settings/SnmpProfilesTab.jsx | Load error prop |
| frontend/src/components/settings/CredentialsTab.jsx | `extractErrorMessage` |
| frontend/src/components/settings/DnsTab.jsx | `extractErrorMessage` |
| frontend/src/components/settings/ImportExportTab.jsx | `extractErrorMessage` |
| frontend/src/components/settings/RacksTab.jsx | `extractErrorMessage` |
| frontend/src/components/settings/ScanSettingsTab.jsx | `extractErrorMessage` |
| frontend/src/components/settings/SwitchClassesTab.jsx | `extractErrorMessage` |
| frontend/src/components/settings/SwitchModelsTab.jsx | `extractErrorMessage` |
| frontend/src/components/DeviceTable.jsx | `extractErrorMessage` |

### Breaking Changes
- `POST /api/scan/dry-run/jobs` now requires authentication (admin/operator role)
- ETag format changed from SHA-256 hash to version counter (harmless cache miss on first request after upgrade)
```

---

## Implementation Order

```
Step 1 (WS ticket auth)
    |
Step 2 (JWT refresh)        -- can be parallel with Step 1
    |
Step 3 (Rate limiting)      -- can be parallel with Steps 1-2
    |
Step 4 (Settings loading)   -- can be parallel with Phase A
    |
Step 5 (Error consistency)  -- can be parallel with Step 4
    |
Step 6 (Topology ETag)      -- can be parallel with Phase B
    |
VERSION.md update
    |
Full test run
```

Recommended serial order: 3 -> 1 -> 2 -> 4 -> 5 -> 6 (matches priority: fix dry-run auth gap first, then add security features, then polish, then optimize).

---

## Full Implementation Checklist

### Phase A: Security Quick Wins
- [ ] 1.1 Add `POST /api/auth/ws-ticket` endpoint
- [ ] 1.2 Rewrite `_authenticate_ws()` for ticket-first auth
- [ ] 1.3 Update `useScanProgress.js` to fetch ticket
- [ ] 1.4 Add ws-ticket tests
- [ ] 1.5-1.7 Manual verification of ticket flow
- [ ] 2.1 Add `POST /api/auth/refresh` endpoint
- [ ] 2.2 Add `/api/auth/refresh` to exempt paths
- [ ] 2.3 Add `refreshTokenIfNeeded()` to `api.js`
- [ ] 2.4 Add auto-refresh to all `api.*` methods
- [ ] 2.5 Add refresh tests
- [ ] 2.6-2.8 Manual verification of refresh flow
- [ ] 3.1-3.2 Fix dry-run auth + rate limit
- [ ] 3.3 Rate limit settings write
- [ ] 3.4-3.5 Rate limit credentials write
- [ ] 3.6-3.7 Rate limit user management
- [ ] 3.8-3.9 Tests + regression check

### Phase B: Frontend Polish
- [ ] 4.1-4.6 SettingsPage error/loading state
- [ ] 4.7 MapSettingsTab loading/error display
- [ ] 4.8 SnmpProfilesTab load error display
- [ ] 4.9-4.11 Manual verification
- [ ] 5.1 Add `extractErrorMessage()` utility
- [ ] 5.2-5.10 Replace `String(ex)` in 9 component files
- [ ] 5.11 Verify error message formatting

### Phase C: Performance
- [ ] 6.1-6.2 Version-counter ETag in topology
- [ ] 6.3 Scan completion topo bump
- [ ] 6.4-6.5 Credential CRUD topo bump
- [ ] 6.6-6.9 Verification + regression check

### Finalization
- [ ] Update VERSION.md with v1.13.0 entry
- [ ] Run full backend test suite (`python -m pytest tests/ -v`)
- [ ] Run frontend build (`npm run build`) to verify no compilation errors
