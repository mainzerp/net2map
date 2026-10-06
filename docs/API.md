# Net2Map -- API Reference

Agent-facing reference for the Net2Map backend HTTP and WebSocket API. Derived from
the code; when this document and the code disagree, the code wins.

Sources of truth:

- Router mounting and middleware: `backend/main.py`, `backend/shared/api_version.py`
- Authentication and roles: `backend/shared/auth.py`, `backend/routers/auth.py`
- Endpoints: `backend/routers/*.py`
- Schemas: `backend/schemas.py`
- Error helper: `backend/shared/errors.py`

The authoritative per-field reference is the generated OpenAPI document (see
[OpenAPI UI](#openapi-ui)). This file gives the map: paths, roles, intent, schema
names.

## Base URL and versioning

| Prefix | Status | Notes |
|---|---|---|
| `/api/v1` | Canonical | All API routers are mounted here first. Listed in OpenAPI. |
| `/api` | Deprecated alias | Same routers, same responses, hidden from OpenAPI. Every HTTP response (including 4xx errors from exception handlers) carries `Deprecation: true` and `Link: </api/v1/...>; rel="successor-version"` (same remaining path and query string). Added by `LegacyApiDeprecationMiddleware`. |
| none | Unversioned infrastructure | `GET /health`, `GET /metrics`, WebSocket `/ws/scan-progress`. |

- `/api/v1` routes are registered before `/api` routes, so a legacy route can never
  shadow a v1 route.
- The frontend uses logical `/api/...` paths internally and maps them to
  `/api/v1/...` centrally in `frontend/src/api.ts`.
- New clients must use `/api/v1` only. A future version would be added to
  `VERSIONED_API_PREFIXES` in `shared/api_version.py` and mounted in `main.py`.
- In the Docker stack the nginx frontend container proxies `/api/`, `/ws/` and the
  OpenAPI paths `/docs`, `/redoc`, `/openapi.json` to the backend
  (`frontend/nginx.conf`). `/health` and `/metrics` are not reachable through port
  3000; the backend port 8000 is not published by `docker-compose.yml`. See
  `docs/OPERATIONS.md`.

All paths in the tables below are relative to `/api/v1` unless marked otherwise.

### OpenAPI UI

Enabled by default; set `OPENAPI_ENABLED=false` to remove all three routes (they
then return 404):

- Swagger UI: `/docs`
- ReDoc: `/redoc`
- OpenAPI JSON: `/openapi.json`

URLs: `http://localhost:3000/docs` in the Docker stack (proxied by nginx),
`http://localhost:8000/docs` in local dev. The pages and the schema are served
without authentication (plain Starlette routes, not behind the global auth
dependency); every API call made from them still needs a bearer token (Swagger UI
"Authorize" button, `HTTPBearer` scheme). `main.py` registers the docs pages itself
(`docs_url=None`, `redoc_url=None`) so they carry a docs-specific
`Content-Security-Policy`: scripts only from `https://cdn.jsdelivr.net` plus the
sha256 of FastAPI's inline bootstrap script, styles/fonts from jsDelivr and Google
Fonts (ReDoc), `connect-src 'self'`. nginx does not add its SPA CSP on these paths.
The Swagger validator badge is disabled (`validatorUrl: null`). The OpenAPI
document lists only `/api/v1` paths; `/health`, `/metrics` and the legacy alias are
excluded (`include_in_schema=False`).

## Authentication

### Modes

Authentication is configured by two environment variables (see
`docs/OPERATIONS.md`). The JWT signing key is `JWT_SECRET or SECRET_TOKEN`
(`shared/auth.py`).

| `JWT_SECRET` | `SECRET_TOKEN` | Behaviour |
|---|---|---|
| set | any | JWT mode. Only JWTs signed with `JWT_SECRET` are accepted. A set `SECRET_TOKEN` is ignored (warning logged). |
| empty | set | Legacy mode. The raw `SECRET_TOKEN` value is accepted as a bearer token and maps to user `legacy` with role `admin`. Login still works and issues JWTs signed with `SECRET_TOKEN`. |
| empty | empty | Auth disabled. Every request runs as `anonymous` with role `admin`. A critical warning is logged at startup. |

Note: `docker-compose.yml` requires `SECRET_TOKEN` and defaults `JWT_SECRET` to
empty, so a stock compose deployment without `JWT_SECRET` runs in legacy mode.

### Transport

- Bearer token only: `Authorization: Bearer <token>`. There are no auth cookies and
  no CSRF token in the implementation. The frontend stores the token in
  `localStorage` (`auth_token`).
- A global dependency (`_require_auth`) applies to every HTTP route of the app.
  Exempt paths (matched against the server-parsed path, version-independent):
  `/health`, `/auth/login`, `/auth/refresh`, `/map-background`. On exempt paths a
  presented valid token is still honored ("soft auth"), so role-guarded methods on
  those paths (upload/delete of the map background) still require a token.
- `/metrics` is NOT exempt: with auth enabled it requires a bearer token.

### Tokens

- Algorithm HS256. Claims: `sub` (user id), `username`, `role`, `jti`, `iat`, `exp`.
- Lifetime: `JWT_EXPIRY_HOURS` (default 24).
- Refresh grace: a token may be refreshed up to 3600 s after `exp`
  (`REFRESH_GRACE_SECONDS`).
- Revocation (requires Redis): per-token blacklist keyed by `jti` (logout) and a
  per-user "revoke all before timestamp" key (admin revoke, password change, role
  change, deactivation, deletion). If `REDIS_URL` is configured but Redis is
  unreachable, token validation fails with `503 AUTH_UNAVAILABLE`. Without
  `REDIS_URL`, revocation checks are skipped, and operations that must revoke
  sessions return `503` instead of pretending success.

### Login and refresh flow

1. `POST /api/v1/auth/login` with `LoginRequest` `{username, password}` ->
   `TokenResponse` `{access_token, token_type: "bearer", role, username}`.
   Rate limit 5/minute per client IP. Unknown users and wrong passwords both return
   `401 AUTH_INVALID_CREDENTIALS` (timing-equalized).
2. Send `Authorization: Bearer <access_token>` on every request.
3. Before or shortly after expiry, `POST /api/v1/auth/refresh` with the current token
   in the `Authorization` header -> new `TokenResponse`. Rate limit 10/minute. The
   user must still exist and be active (`401 AUTH_USER_INACTIVE` otherwise).
4. `POST /api/v1/auth/logout` blacklists the current token's `jti`.

The initial `admin` user is created by Alembic migration 006 with the password from
`DEFAULT_ADMIN_PASSWORD` (only used at that first migration; changing the variable
later does not change the password).

### RBAC roles

Roles (`UserRole` in `schemas.py`): `admin`, `operator`, `viewer`. Enforcement is
`require_role(...)` in `shared/auth.py`; missing role -> `403 AUTH_FORBIDDEN`.

General pattern derived from the routers (exceptions are listed per router):

- Read (GET): any authenticated user, including `viewer`.
- Create/update: `admin` or `operator`.
- Delete, imports, user management, audit log: `admin` only.

Role column legend in the tables: `public` = auth-exempt path, `any` = any
authenticated user, `op+` = `admin` or `operator`, `admin` = admin only.

### Rate limits

Declared per endpoint with slowapi (`@limiter.limit`), keyed by client IP
(`get_remote_address`; uvicorn runs with `--proxy-headers`). Limits are noted in the
tables where present. Counters live in Redis when `REDIS_URL` is set (shared across
uvicorn workers; `config.py` exports `RATELIMIT_STORAGE_URL` for every router-level
limiter, with an in-memory fallback while Redis is unreachable), otherwise in
process memory.

## WebSocket: scan progress

Endpoint: `/ws/scan-progress` (unversioned). Query parameter `token`.

Ticket flow (preferred, needs Redis):

1. `POST /api/v1/auth/ws-ticket` with a valid bearer token -> `{"ticket": "..."}`.
   The ticket is stored in Redis for 30 s, together with the originating token.
   Without Redis: `503 REDIS_UNAVAILABLE`.
2. Connect to `/ws/scan-progress?token=<ticket>`. The ticket is consumed atomically
   (Redis `GETDEL`, Redis >= 6.2), so it is single-use.
3. Fallback: `token=<raw JWT>` (or the legacy `SECRET_TOKEN`) is also accepted, with
   the same blacklist and revocation checks as HTTP.

After connect, the originating credential is rechecked every 5 s
(`AUTH_RECHECK_SECONDS`), also without client traffic. Close codes: `1008` for
missing/invalid/expired/revoked credentials, `1011` when the auth service (Redis)
is unavailable or times out (5 s). With auth disabled no token is needed.

Server-to-client messages (JSON, `backend/scan_engine/broadcast.py`):

- `{"type": "scan_progress", "job_id", "scanned", "total", "latest_ip", "success"}`
- `{"type": "scan_complete", "job_id", "status", "found", "links", "duration_ms"}`

Scans running in the Celery worker publish to a Redis pub/sub channel; the web
process forwards them to its connected clients. Client messages are read and
ignored.

## Error format

Errors raised through `api_error()` or `HTTPException` are normalized by the
handlers in `main.py` to the `APIError` shape:

```json
{"error": {"code": "DEVICE_NOT_FOUND", "message": "Device not found", "field": "optional", "details": []}}
```

- `field` and `details` are optional.
- `HTTPException` with a plain string detail becomes code `HTTP_ERROR`.
- Unhandled exceptions become `500` with code `INTERNAL_ERROR`.
- Common auth codes: `AUTH_MISSING`, `AUTH_INVALID`, `AUTH_EXPIRED`, `AUTH_REVOKED`,
  `AUTH_REQUIRED`, `AUTH_FORBIDDEN` (403), `AUTH_UNAVAILABLE` (503),
  `AUTH_INVALID_CREDENTIALS`, `AUTH_USER_INACTIVE`. 401 responses carry
  `WWW-Authenticate: Bearer`.

Exceptions to the shape (not normalized by a custom handler):

- Request validation errors (`422`) use the FastAPI default `{"detail": [...]}`;
  there is no custom `RequestValidationError` handler.
- Rate limit errors (`429`) come from slowapi's default handler, not the `APIError`
  shape.

## Conditional GET (ETag)

`GET /topology`, `GET /devices` and `GET /endpoints` return an `ETag` with
`Cache-Control: no-cache` and answer `304 Not Modified` when `If-None-Match` matches.
These three endpoints build the JSON response manually, so they have no
`response_model` in OpenAPI; their bodies are `TopologyOut`, `DeviceOut[]` and
`EndpointOut[]` respectively.

## Central schemas

Key fields only; see OpenAPI for the full list.

### DeviceOut

Fields from `DeviceBase`: `sys_name`, `ip`, `sys_descr`, `model`, `firmware`,
`vendor`, `location`, `ping_status`, `ping_rtt_ms`, `map_x`, `map_y`, `ignored`,
`label`, `enabled`, `vendor_override`. Plus:

- `id`, `last_seen`, `ports: PortOut[]`
- `rack_id`, `class_id`, `model_id`, `rack_u_position` (1..48 or null = not placed),
  `u_height` (default 1)
- `ports_per_row`, `total_ports`: resolved from the assigned switch model
- `stp: StpInfo | null`: bridge-level spanning tree summary of the default instance.
  `StpInfo` = `protocol` (`stp|rstp|mstp|unknown`), `bridge_id`
  (`"<prio hex4>.<mac hex12>"`), `root_id`, `root_cost`, `root_port` (null on the
  root bridge), `is_root`. `null` when no STP data was collected. The raw
  `stp_*` device columns are input-only and excluded from the output.
- `vlan_names: {vlan_id_string: name}`: always an object (empty when unknown).

### PortOut

`id`, `if_index`, `if_descr`, `if_alias`, `speed_mbps`, `oper_status`,
`endpoint_count` (computed from endpoint associations), `vlan` (untagged/PVID),
`tagged_vlans: int[]`, plus STP per port:

- `stp_state`: `disabled|blocking|listening|learning|forwarding|broken` (BRIDGE-MIB), or null
- `stp_role`: `root|designated|blocked|disabled` (derived from state and root port), or null
- `stp_path_cost`: int or null

### TopologyLinkOut

`id`, `local_ip`, `local_port`, `remote_ip`, `remote_sys`, `remote_port`,
`speed_label`, `discovered_at`. `GET /topology` only returns links whose both ends
are non-ignored devices.

### TopologyOut

`nodes: DeviceOut[]` (non-ignored devices), `links: TopologyLinkOut[]`,
`racks: RackOut[]`, `classes: SwitchClassOut[]`, `models: SwitchModelOut[]`.

### Secret masking

`CredentialOut` and `SnmpProfileOut` mask `community`, `v3_auth_password` and
`v3_priv_password` as `***`; config/bulk exports use `********`. Both sentinels sent
back on update mean "unchanged" and are never stored.

## Routers

Infrastructure routes are listed first, then the API routers in `main.py` mount
order. 19 router modules total (`health` and `ws` are unversioned).

### health (`routers/health.py`) -- unversioned

Component health for container healthchecks and monitoring.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/health` (no prefix) | public | Liveness: database (`SELECT 1`) and Redis ping. `200` when both are OK (Redis may be `not_configured`), `503` otherwise. Does not ping Celery, so a missing worker never marks the backend container unhealthy. Used by the compose healthcheck. | `{"status": "ok"\|"degraded", "checks": {database, redis}}` |
| GET | `/health?deep=1` (no prefix) | public | Readiness: as above plus a Celery worker ping (timeout 2 s). `503` also when no worker answers (`none`) or the broker is unreachable (`unreachable`) while Redis is configured. | `{"status", "checks": {database, redis, celery}, "workers": "ok"\|"none"\|"unreachable"\|"not_configured"}` |

### metrics (`main.py`) -- unversioned

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/metrics` (no prefix) | any (bearer required when auth is enabled) | Prometheus exposition format. | text |

### ws (`routers/ws.py`) -- unversioned

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| WS | `/ws/scan-progress` (no prefix) | ticket or token in `?token=` | Real-time scan progress. See [WebSocket](#websocket-scan-progress). | JSON messages |

### settings (`routers/settings.py`)

Generic key/value app settings and dashboard statistics.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/settings` | any | List all app settings. | `AppSettingOut[]` |
| PUT | `/settings/{key}` | op+ | Upsert one setting. Only allowlisted keys (`ALLOWED_SETTING_KEYS`: discovery/link/mac/port intervals, `discovery_scan_ranges`, `scan_max_workers`, `scan_snmp_timeout`, `scan_snmp_retries`, `dns_servers`, `map_opacity`, `map_scale`, `map_bg_color`, `audit_retention_days`); others -> `400 UNKNOWN_SETTING_KEY`. 10/min. | `AppSettingUpdate` -> `AppSettingOut` |
| GET | `/stats` | any | Counts (devices, ports, ports up, racks, endpoints) and last scan time/status. | ad-hoc object |

### credentials (`routers/credentials.py`)

SNMP credentials (per IP or device, with priority and optional profile).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/credentials` | any | List credentials (secrets masked). | `CredentialOut[]` |
| POST | `/credentials` | op+ | Create credential; secrets encrypted with `ENCRYPTION_KEY` when set. | `CredentialCreate` -> `CredentialOut` (201) |
| PUT | `/credentials/{cred_id}` | op+ | Update; mask sentinels mean "unchanged". | `CredentialUpdate` -> `CredentialOut` |
| DELETE | `/credentials/{cred_id}` | admin | Delete. | 204 |

### snmp_profiles (`routers/snmp_profiles.py`)

Reusable SNMP parameter sets (v2c community or v3 USM settings).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/snmp-profiles` | any | List profiles (secrets masked). | `SnmpProfileOut[]` |
| POST | `/snmp-profiles` | op+ | Create. | `SnmpProfileCreate` -> `SnmpProfileOut` (201) |
| PUT | `/snmp-profiles/{profile_id}` | op+ | Update; mask sentinels mean "unchanged". | `SnmpProfileUpdate` -> `SnmpProfileOut` |
| DELETE | `/snmp-profiles/{profile_id}` | admin | Delete. | 204 |

### racks (`routers/racks.py`)

Physical racks and rack elevation layout.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/racks` | any | List racks. | `RackOut[]` |
| POST | `/racks` | op+ | Create (`height_u` 6..60, default 42). | `RackCreate` -> `RackOut` (201) |
| PUT | `/racks/{rack_id}` | op+ | Update. | `RackUpdate` -> `RackOut` |
| DELETE | `/racks/{rack_id}` | admin | Delete. | 204 |
| PATCH | `/racks/{rack_id}/layout` | op+ | Set U positions/heights of devices in this rack. Omitted devices stay in place. Rejects duplicates and devices not in the rack (422), unknown devices (404), out-of-range placements and U overlaps (409 `U_POSITION_OUT_OF_RANGE`, `U_OVERLAP`). | `RackLayoutIn` `{entries: [{device_id, rack_u_position, u_height}]}` -> `{"updated": n}` |

### switch_classes (`routers/switch_classes.py`)

Device classes (e.g. core/access) used for map styling and rack rules
(`allow_outside_rack`).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/switch-classes` | any | List. | `SwitchClassOut[]` |
| POST | `/switch-classes` | op+ | Create. | `SwitchClassCreate` -> `SwitchClassOut` (201) |
| PUT | `/switch-classes/{class_id}` | op+ | Update. | `SwitchClassUpdate` -> `SwitchClassOut` |
| DELETE | `/switch-classes/{class_id}` | admin | Delete. | 204 |

### switch_models (`routers/switch_models.py`)

Hardware models; provide `ports_per_row` and `total_ports` for port rendering.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/switch-models` | any | List. | `SwitchModelOut[]` |
| POST | `/switch-models` | op+ | Create. | `SwitchModelCreate` -> `SwitchModelOut` (201) |
| PUT | `/switch-models/{model_id}` | op+ | Update. | `SwitchModelUpdate` -> `SwitchModelOut` |
| DELETE | `/switch-models/{model_id}` | admin | Delete. | 204 |

### scan (`routers/scan.py`)

Starts, polls and cancels SNMP discovery scans. Jobs run in Celery when Redis is
available, otherwise in a backend thread.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| POST | `/scan` | op+ | Deprecated (`deprecated=True`). Starts a full scan job and polls until done (max 600 s; `504 SCAN_TIMEOUT`, `409 SCAN_CONFLICT`). 2/min. | -> `ScanResult` |
| POST | `/scan/jobs` | op+ | Start a background scan; returns immediately. 5/min. | -> `{job_id, status: "queued"\|"running"}` |
| POST | `/scan/dry-run/jobs` | op+ | Start a background dry-run discovery (no persistence of devices); job result contains a `preview` key. 3/min. | -> `{job_id, status}` |
| GET | `/scan/jobs/{job_id}` | any | Job status. Terminal statuses: `finished`, `failed`, `cancelled`, `skipped`, `dry_run`. | -> `{id, status, started_at, finished_at, cancel_requested, result}` |
| POST | `/scan/jobs/{job_id}/cancel` | op+ | Request cancellation of a `running`/`queued` job. | -> `{id, status, cancel_requested}` |

`ScanResult`: `scanned`, `found`, `links`, `errors[]`, `max_workers`,
`total_duration_ms`, `switch_metrics: ScanSwitchMetric[]` (`ip`, `label`,
`duration_ms`, `success`, `error`), `status`, `run_id`.

### scan_runs (`routers/scan_runs.py`)

Scan history with diffs against the previous run.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/scan-runs?limit=20` | any | Latest runs (limit clamped 1..200) with `new_devices`, `removed_devices`, `new_links`, `removed_links` diffed against the predecessor, plus per-switch metrics. | `ScanRunOut[]` |
| GET | `/scan-runs/{run_id}/dry-run-preview` | any | Stored dry-run preview for a run (`404 DRY_RUN_NOT_FOUND`). | JSON list (items shaped like `DryRunPreviewItem`) |

### topology (`routers/topology.py`)

Map data, device list and device metadata edits. Write operations bump the topology
version (invalidates the `GET /topology` ETag cache).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/topology` | any | Full map: non-ignored devices, links, racks, classes, models. ETag/304. | `TopologyOut` |
| GET | `/devices` | any | All devices including ignored, ordered by IP. ETag/304. | `DeviceOut[]` |
| PATCH | `/topology/devices/{device_id}/position` | op+ | Persist drag-and-drop position. | `DevicePositionUpdate` `{map_x, map_y}` -> `DeviceOut` |
| PATCH | `/topology/racks/{rack_id}/position` | op+ | Persist rack position on the map. | `RackPositionUpdate` -> `RackOut` |
| PATCH | `/topology/devices/bulk-meta` | op+ | Bulk set `ignored`, `rack_id` / `clear_rack`, `class_id` (enforces `allow_outside_rack`). | `BulkDeviceMetaUpdate` -> `{"updated": n}` |
| PATCH | `/topology/devices/{device_id}/meta` | op+ | Partial update of location, sys_name, vendor (sets `vendor_override`), model, rack/class/model ids, ignored, label, enabled, `rack_u_position` (null unplaces), `u_height`, `vendor_override`. | `DeviceMetaUpdate` -> `DeviceOut` |

### map_bg (`routers/map_bg.py`)

Map background image and display settings. The image is stored under `/data` in the
backend container; opacity/scale/color are stored as app settings in the database.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| POST | `/map-background` | op+ (token required although the path is auth-exempt) | Upload/replace (multipart field `file`). Allowed: png, jpeg, gif, webp (magic-byte check) and SVG (sanitized against an element allowlist). Max 20 MB (`FILE_TOO_LARGE`, `shared/file_settings.py`); nginx allows bodies up to 25 MB. 5/min. | -> `{ok, filename, size}` |
| GET | `/map-background` | public | Serve the stored image (`Content-Security-Policy: script-src 'none'`). Single byte range only (`416` otherwise). `404 NO_BACKGROUND_IMAGE` when unset. | file |
| DELETE | `/map-background` | admin (token required) | Remove the image. | -> `{ok}` |
| GET | `/map-settings` | any | Background opacity, scale, color. | `MapSettingsOut` |
| PUT | `/map-settings` | op+ | Update (opacity clamped 0..1, scale 0.1..10, color max 20 chars). | `MapSettingsUpdate` -> `MapSettingsOut` |

### scan_settings (`routers/scan_settings.py`)

Scan tuning, discovery ranges and DNS resolvers.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/scan-settings` | any | Current values. | `ScanSettingsOut` `{max_workers, snmp_timeout, snmp_retries}` |
| PUT | `/scan-settings` | op+ | Update (clamped: workers 1..128, timeout 1..30, retries 0..10). | `ScanSettingsUpdate` -> `ScanSettingsOut` |
| GET | `/discovery-ranges` | any | IP/CIDR ranges for discovery. | `DiscoveryRangesOut` `{ranges}` |
| PUT | `/discovery-ranges` | op+ | Replace ranges (`400 INVALID_IP_RANGE` on bad entries). | `DiscoveryRangesUpdate` -> `DiscoveryRangesOut` |
| GET | `/dns-settings` | any | DNS servers for PTR lookups. | `DnsSettingsOut` `{servers}` |
| PUT | `/dns-settings` | op+ | Replace DNS servers. | `DnsSettingsUpdate` -> `DnsSettingsOut` |

### bulk (`routers/bulk.py`)

CSV/JSON export and import of credentials and SNMP profiles. `kind` is
`credentials` or `profiles`.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/bulk-export/{kind}?fmt=json\|csv` | op+ | Export with secrets masked (`********`). | `BulkExportOut` `{type, format, data}` |
| POST | `/bulk-import/{kind}` | admin | Validate and import rows; `dry_run` defaults to `true`. | `BulkImportRequest` `{format, data, dry_run}` -> `BulkImportResult` |

### config (`routers/config.py`)

Global configuration export/import (app settings, profiles, credentials).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/config/export` | op+ | JSON string with `version`, `exported_at`, `settings`, `profiles`, `credentials` (secrets masked; FK references also as `profile_label` / `device_ip`). 10/min. | `GlobalConfigExportOut` `{data}` |
| POST | `/config/import` | admin | Validate and import an export payload; `dry_run` defaults to `true`. | `GlobalConfigImportRequest` `{data, dry_run}` -> result object (no `response_model`) |

### logs (`routers/logs.py`)

In-memory structured backend log buffer (per backend process).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/logs?limit=200&level=&event_prefix=&q=` | op+ | Recent structured log entries, filterable. | list of log entry objects |

### auth (`routers/auth.py`)

Login, token lifecycle and user management.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| POST | `/auth/login` | public | Username/password login. 5/min. | `LoginRequest` -> `TokenResponse` |
| POST | `/auth/refresh` | public (needs current token in header) | Refresh a valid or up to 1 h expired token. 10/min. | -> `TokenResponse` |
| GET | `/auth/me` | any | Current user from the token. | `{id, username, role}` |
| POST | `/auth/ws-ticket` | any | Issue a 30 s single-use WebSocket ticket (needs Redis). | -> `{ticket}` |
| POST | `/auth/logout` | any | Blacklist the current token (`503` if Redis unavailable). | -> `{status: "ok"}` |
| POST | `/auth/revoke-all` | admin | Revoke all sessions of `user_id` (body `{"user_id": n}`), or of the caller when omitted. | -> `{status, user_id}` |
| GET | `/users` | admin | List users. | `UserOut[]` |
| POST | `/users` | admin | Create user (password min 8 chars, default role `viewer`). 10/min. | `UserCreate` -> `UserOut` (201) |
| PUT | `/users/{user_id}` | admin | Update email/password/role/is_active. Revokes sessions on password, role or deactivation change. Cannot demote/deactivate yourself or the last active admin (`CANNOT_MODIFY_SELF`, `LAST_ADMIN`). 10/min. | `UserUpdate` -> `UserOut` |
| DELETE | `/users/{user_id}` | admin | Delete user (same lockout guards; revokes sessions first). 10/min. | 204 |

### audit (`routers/audit.py`)

Audit trail of write operations (`shared/audit.py`).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/audit-logs?limit=100` | admin | Newest entries first (limit 1..500). | `AuditLogOut[]` |
| DELETE | `/audit-logs/purge?days=` | admin | Delete entries older than `days`. Default: the `audit_retention_days` app setting when it is a positive integer, else `AUDIT_RETENTION_DAYS` (env, default 90); same resolution as the scheduled purge (`shared/audit.py:get_audit_retention_days`). | -> `{deleted, cutoff}` |

### endpoints (`routers/endpoints.py`)

End hosts (MAC/IP/hostname) learned from switch forwarding tables, with the ports
they were seen on.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/endpoints` | any | All endpoints ordered by MAC. ETag/304. | `EndpointOut[]` |
| GET | `/endpoints/{endpoint_id}` | any | One endpoint. | `EndpointOut` |
| PATCH | `/endpoints/bulk` | op+ | Bulk set `ignored`. | `BulkEndpointUpdate` -> `{"updated": n}` |
| PATCH | `/endpoints/{endpoint_id}` | op+ | Update `ignored` / `notes`. | `EndpointUpdate` -> `EndpointOut` |
| DELETE | `/endpoints/{endpoint_id}` | admin | Delete. | -> `{"deleted": true}` |

`EndpointOut`: `id`, `mac`, `ip`, `hostname`, `first_seen`, `last_seen`, `ignored`,
`notes`, `found_on: EndpointPortInfo[]` (`port_id`, `switch_ip`, `switch_name`,
`port_name`, `vlan_id`, `last_seen`).

## Open points

- Responses without a `response_model` (`/stats`, `/auth/me`, scan job endpoints,
  `/logs`, `/config/import`, dry-run preview) are not typed in OpenAPI; their shape
  is defined only by the router code.
