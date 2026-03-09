# Map Background Upload - Implementation Plan

## Overview

Fix three bugs preventing map background image uploads from working correctly. The root cause is a broken auth token flow, compounded by an nginx body size limit and missing error feedback.

**Files to modify:**
1. `frontend/src/api.js` -- export `_getAuthHeader` for reuse
2. `frontend/src/pages/SettingsPage.jsx` -- fix auth, add error handling
3. `frontend/nginx.conf` -- add `client_max_body_size`

---

## Checklist

- [ ] Step 1: Export `_getAuthHeader` from `api.js`
- [ ] Step 2: Fix `uploadMapBg` auth and add error handling in `SettingsPage.jsx`
- [ ] Step 3: Add `client_max_body_size 25m` to nginx `/api/` location block

---

## Step 1: Export `_getAuthHeader` from `api.js`

**File:** `frontend/src/api.js`
**Why:** `_getAuthHeader()` is currently a module-private function. Exporting it allows `SettingsPage.jsx` to reuse the same auth logic used by all `api.*` methods, instead of duplicating token retrieval code.

### Before (line 7-10):
```javascript
// Auth token from localStorage (JWT or legacy token)
function _getAuthHeader() {
  const token = localStorage.getItem("auth_token") || import.meta.env.VITE_API_TOKEN || "";
  return token ? { Authorization: "Bearer " + token } : {};
}
```

### After:
```javascript
// Auth token from localStorage (JWT or legacy token)
export function _getAuthHeader() {
  const token = localStorage.getItem("auth_token") || import.meta.env.VITE_API_TOKEN || "";
  return token ? { Authorization: "Bearer " + token } : {};
}
```

**Change:** Add `export` keyword to the function declaration.

---

## Step 2: Fix `uploadMapBg` in `SettingsPage.jsx`

**File:** `frontend/src/pages/SettingsPage.jsx`

### Step 2a: Update import to include `_getAuthHeader`

#### Before (line 2):
```javascript
import { api, API } from "../api.js";
```

#### After:
```javascript
import { api, API, _getAuthHeader } from "../api.js";
```

### Step 2b: Rewrite `uploadMapBg` function (Bug 1 + Bug 3)

#### Before (lines 45-51):
```javascript
  const uploadMapBg = async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    const TOKEN = import.meta.env.VITE_API_TOKEN || "";
    const headers = TOKEN ? { Authorization: "Bearer " + TOKEN } : {};
    await fetch(`${API}/api/map-background`, { method: "POST", body: fd, headers });
    setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`);
  };
```

#### After:
```javascript
  const uploadMapBg = async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API}/api/map-background`, {
      method: "POST",
      body: fd,
      headers: _getAuthHeader(),
    });
    if (!res.ok) {
      let msg;
      try { const b = await res.json(); msg = b?.detail || res.statusText; } catch { msg = res.statusText; }
      alert(`Upload failed: ${msg}`);
      return;
    }
    setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`);
  };
```

**Changes explained:**
1. **Bug 1 fix:** Replaced `import.meta.env.VITE_API_TOKEN` with `_getAuthHeader()` which reads from `localStorage.getItem("auth_token")` first (same as every other API call).
2. **Bug 3 fix:** Added `res.ok` check. On failure, extracts error detail from the JSON response body (matching FastAPI's `{"detail": "..."}` format) and shows it via `alert()`. Returns early so `setMapBgUrl` is NOT called on failure.
3. **No Content-Type header set:** This is intentional -- the browser must auto-generate the `multipart/form-data` boundary. Setting `Content-Type` manually would break the upload.

---

## Step 3: Add `client_max_body_size` to nginx

**File:** `frontend/nginx.conf`

### Before (lines 15-23):
```nginx
    # Proxy /api/* to the FastAPI backend
    location /api/ {
        proxy_pass         http://backend:8000/api/;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 10s;
    }
```

### After:
```nginx
    # Proxy /api/* to the FastAPI backend
    location /api/ {
        client_max_body_size 25m;
        proxy_pass         http://backend:8000/api/;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 10s;
    }
```

**Change:** Added `client_max_body_size 25m;` as the first directive inside the `/api/` location block. This allows uploads up to 25 MB through nginx (the backend enforces its own 20 MB limit via `MAX_FILE_SIZE`). The nginx default of 1 MB would reject any image larger than 1 MB with a `413 Request Entity Too Large` before it reaches FastAPI.

**Why 25m instead of 20m:** Provides a small buffer above the backend's 20 MB limit. The backend will still enforce the exact file size limit and return a proper error message. If nginx rejects at exactly 20 MB, multipart overhead could cause valid files just under the limit to fail.

---

## Verification

After applying all three changes:

1. **Auth works:** The upload request will include `Authorization: Bearer <jwt_token>` from localStorage, matching the pattern used by all other API calls.
2. **Large files pass nginx:** Files up to 25 MB will pass through nginx to the backend (backend enforces its own 20 MB limit with a clear error).
3. **Errors are visible:** If the upload fails (401, 413, 415, 500, etc.), the user sees an alert with the error detail instead of silent failure.

### Manual test steps:
1. Log in as admin/operator
2. Go to Settings > Map > upload an image < 1 MB -- should succeed
3. Upload an image between 1-20 MB -- should succeed (was blocked by nginx before)
4. Upload a > 20 MB image -- should show backend error "File too large"
5. Log out and try uploading -- should show 401 error in alert
