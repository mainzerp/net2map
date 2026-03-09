# Map Background Upload - Analysis

## Summary

The map background upload is broken due to **two confirmed bugs** and one UX issue. The primary cause is that the upload function sends requests **without JWT authentication**, causing a 401 Unauthorized response that is silently swallowed. A secondary issue is that nginx has no `client_max_body_size` configured (default: 1 MB), which would block any image larger than 1 MB even if auth worked.

---

## Complete Upload Flow

```
User clicks "Upload image" button
  --> MapSettingsTab.jsx: <input type="file"> triggers onChange
  --> SettingsPage.jsx: uploadMapBg(file) called
  --> Raw fetch() POST to /api/map-background with FormData
  --> nginx proxies to backend:8000
  --> FastAPI map_bg.py: upload_map_background() handler
  --> File written to /data/map-background.<ext>
  --> Response returned (ignored by frontend)
  --> Frontend sets bgUrl regardless of success/failure
```

---

## Bug 1 (CRITICAL): Authentication Token Not Sent on Upload

### Location
- File: `frontend/src/pages/SettingsPage.jsx`, lines 45-51

### Code
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

### Problem
The function reads the auth token from `import.meta.env.VITE_API_TOKEN`, which is a **build-time Vite environment variable**. In the Docker deployment, it is empty (docker-compose sets `VITE_API_URL: ""` but not `VITE_API_TOKEN`). This means `headers` is an empty object `{}`, and the request is sent **without any Authorization header**.

The backend endpoint `POST /api/map-background` requires role `admin` or `operator` via `dependencies=[require_role("admin", "operator")]`. The global auth middleware `_require_auth` (applied to all routes via `FastAPI(..., dependencies=[Depends(_require_auth)])`) will reject the request with 401 because no token is provided.

### Correct Pattern
The rest of the application stores the JWT token in `localStorage.getItem("auth_token")` after login, and the shared `api.js` module provides `_getAuthHeader()` which correctly retrieves it:

```javascript
// api.js - correct auth header helper
function _getAuthHeader() {
  const token = localStorage.getItem("auth_token") || import.meta.env.VITE_API_TOKEN || "";
  return token ? { Authorization: "Bearer " + token } : {};
}
```

All other API calls (GET, DELETE, PUT for map background) use `api.get()`, `api.del()`, `api.put()` which internally call `_getAuthHeader()`. Only the upload function bypasses this because `api.post()` hardcodes `Content-Type: application/json` and `JSON.stringify(body)`, making it unsuitable for `FormData` uploads.

### Comparison
- `removeMapBg` (works): uses `api.del("/api/map-background")` which uses `_getAuthHeader()`
- `uploadMapBg` (broken): uses raw `fetch()` with only `VITE_API_TOKEN`

### Fix
Import and use `_getAuthHeader()` (or inline the same logic using `localStorage.getItem("auth_token")`), and do NOT set a `Content-Type` header (the browser must auto-set the multipart boundary):

```javascript
const uploadMapBg = async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    const token = localStorage.getItem("auth_token") || import.meta.env.VITE_API_TOKEN || "";
    const headers = token ? { Authorization: "Bearer " + token } : {};
    const res = await fetch(`${API}/api/map-background`, { method: "POST", body: fd, headers });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`);
};
```

---

## Bug 2 (HIGH): nginx Missing `client_max_body_size`

### Location
- File: `frontend/nginx.conf`

### Code (current)
```nginx
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

### Problem
No `client_max_body_size` directive is set. The nginx default is **1 MB**. The backend `MAX_FILE_SIZE` allows up to **20 MB**. Any upload larger than 1 MB will be rejected by nginx with `413 Request Entity Too Large` before reaching FastAPI.

### Fix
Add `client_max_body_size 25m;` to the `/api/` location block (or server block). Using 25 MB gives headroom above the backend's 20 MB limit.

---

## Bug 3 (MEDIUM): No Error Handling / User Feedback on Upload

### Location
- File: `frontend/src/pages/SettingsPage.jsx`, lines 45-51

### Problem
The upload function does not check the response status. Whether the server returns 401, 413, 500, or any error, it is silently ignored:

```javascript
await fetch(`${API}/api/map-background`, { method: "POST", body: fd, headers });
setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`);  // runs even on failure
```

After a failed upload, `mapBgUrl` is set to the background URL, which triggers a GET that returns 404 (no image stored), and the `.catch()` in `loadMapBackground` silently sets `bgUrl: null`. The user sees no error message at all.

### Fix
Check `res.ok` and surface errors to the user (toast, alert, or inline message).

---

## Infrastructure Analysis (No Issues Found)

### Docker Volume Mount
- `docker-compose.yml`: `netmap-data:/data` is correctly mounted on the backend service
- The celery-worker also mounts the same volume (shared access to `/data`)

### Directory Permissions
- `Dockerfile`: `mkdir -p /data` creates the directory at build time
- `entrypoint.sh`: `chown -R appuser:appuser /data` and `chmod 700 /data` set proper ownership at container start
- The process runs as `appuser` via `gosu appuser` in entrypoint.sh

### Backend File Storage
- `shared/file_settings.py`: `MAP_BG_DIR = "/data"`, `MAP_BG_FILENAME = "map-background"`
- Files stored as `/data/map-background.{png,jpg,jpeg,gif,webp,svg}`
- `_clear_bg_files()` removes old files before writing new one (prevents stale extensions)
- `MAX_FILE_SIZE = 20 * 1024 * 1024` (20 MB)
- File type validation via magic bytes (`filetype.guess()`) and extension check
- SVG sanitization strips script tags and event handlers

### CORS Configuration
- `main.py`: `CORSMiddleware` with `allow_origins=[CORS_ORIGIN]`, `allow_methods=["*"]`, `allow_headers=["*"]`, `allow_credentials=True`
- `CORS_ORIGIN` defaults to `"http://localhost:3000"` matching the Docker frontend port
- No CORS issues expected

### Backend Router Registration
- `main.py` line 88: `app.include_router(map_bg.router)` -- router is registered
- Global auth middleware: `FastAPI(..., dependencies=[Depends(_require_auth)])` -- all routes require auth

### FastAPI Upload Handling
- Endpoint uses `UploadFile = File(...)` which is correct for multipart file uploads
- No body size limit in FastAPI itself (read in full then checked against `MAX_FILE_SIZE`)

---

## Files Analyzed

| File | Purpose | Status |
|------|---------|--------|
| `backend/routers/map_bg.py` | Upload/GET/DELETE endpoints | OK |
| `backend/shared/file_settings.py` | Constants, file I/O helpers | OK |
| `backend/shared/auth.py` | JWT auth, role-based guards | OK |
| `backend/main.py` | App setup, CORS, router registration | OK |
| `backend/Dockerfile` | /data directory creation, appuser setup | OK |
| `backend/entrypoint.sh` | Volume permissions, migrations | OK |
| `frontend/src/api.js` | Shared API helpers, `_getAuthHeader()` | OK |
| `frontend/src/pages/SettingsPage.jsx` | Upload function `uploadMapBg` | **BUGGY** |
| `frontend/src/components/settings/MapSettingsTab.jsx` | Upload UI component | OK |
| `frontend/src/hooks/useMapBackground.js` | Map page background hook | OK |
| `frontend/src/store.js` | Zustand store, `loadMapBackground` | OK |
| `frontend/nginx.conf` | Proxy config, missing body size | **BUGGY** |
| `docker-compose.yml` | Volume mounts, env vars | OK |

---

## Recommended Fixes (Priority Order)

1. **Fix auth in `uploadMapBg`**: Use `localStorage.getItem("auth_token")` instead of only `import.meta.env.VITE_API_TOKEN`
2. **Add `client_max_body_size 25m;`** to nginx `/api/` location block
3. **Add error handling**: Check `res.ok` on upload response and surface errors to user
4. **Refresh store after upload**: After successful upload, call `useNetmapStore.getState().loadMapBackground()` to update the map page
