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

JWT mode only. `JWT_SECRET` is required (the backend refuses to start without it,
see `docs/OPERATIONS.md`); only JWTs signed with it are accepted. The legacy
static `SECRET_TOKEN` bearer and the auth-disabled mode were removed in v4.0.0.

### Transport

- Bearer token only: `Authorization: Bearer <token>`. There are no auth cookies and
  no CSRF token in the implementation. The frontend stores the token in
  `localStorage` (`auth_token`).
- A global dependency (`_require_auth`) applies to every HTTP route of the app.
  Exempt paths (matched against the server-parsed path, version-independent):
  `/health`, `/auth/login`, `/auth/refresh`, `/map-background`, and for `GET` only
  `/floors/{floor_id}/background` (per-floor background images loaded via `<img>`;
  `POST`/`DELETE` on that path are not exempt). On exempt paths a
  presented valid token is still honored ("soft auth"), so role-guarded methods on
  those paths (upload/delete of the map background, `/health?deep=1`) still
  require a token.
- `/metrics` is NOT exempt: it requires a bearer token.

### Tokens

- Algorithm HS256. Claims: `sub` (user id), `username`, `role`, `jti`, `iat`,
  `iat_ms` (issue time in ms), `auth_time` (original login, carried over by
  refresh), `exp`.
- Lifetime: `JWT_EXPIRY_HOURS` (default 24).
- Refresh grace: a token may be refreshed up to 3600 s after `exp`
  (`REFRESH_GRACE_SECONDS`).
- Absolute session lifetime: `JWT_MAX_SESSION_HOURS` (default 168) after
  `auth_time`; then refresh fails with `401 AUTH_SESSION_EXPIRED`.
- Per-user revocation (database, migration 029): `users.revoked_before_ms` is set
  on admin revoke-all, password change, role change, deactivation and on logout
  without Redis; tokens issued at or before it are rejected (`401 AUTH_REVOKED`).
  Deleted or inactive users' tokens are always rejected. Works without Redis;
  other processes see the change within 5 s (per-process cache).
- Per-token revocation (Redis): blacklist keyed by `jti` (logout, refresh
  rotation). If `REDIS_URL` is configured but Redis is unreachable, token
  validation fails with `503 AUTH_UNAVAILABLE`.
- Passwords: 8 characters to 72 bytes. Longer new passwords -> `422`; at login
  they fail like a wrong password (login fields above 1024 characters -> `422`).

### Login and refresh flow

1. `POST /api/v1/auth/login` with `LoginRequest` `{username, password}` ->
   `TokenResponse` `{access_token, token_type: "bearer", role, username}`.
   Rate limit 5/minute per client IP. Unknown users and wrong passwords both return
   `401 AUTH_INVALID_CREDENTIALS` (timing-equalized).
2. Send `Authorization: Bearer <access_token>` on every request.
3. Before or shortly after expiry, `POST /api/v1/auth/refresh` with the current token
   in the `Authorization` header -> new `TokenResponse`. Rate limit 10/minute. The
   user must still exist and be active (`401 AUTH_USER_INACTIVE` otherwise). The
   consumed token is blacklisted when Redis is available (a second refresh with it
   -> `401 AUTH_REVOKED`); `auth_time` is kept, so the chain ends after
   `JWT_MAX_SESSION_HOURS` (`401 AUTH_SESSION_EXPIRED`).
4. `POST /api/v1/auth/logout` blacklists the current token's `jti` ->
   `{"status": "ok"}`. Without Redis (or when the blacklist write fails) it revokes
   all sessions of the user -> `{"status": "ok", "revoked": "all_sessions"}`
   (`"revoked": "none"` for a deleted user). `503 AUTH_UNAVAILABLE` only when
   neither revocation can be recorded.

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
3. Fallback: `token=<raw JWT>` is also accepted, with
   the same blacklist and revocation checks as HTTP.

After connect, the originating credential is rechecked every 5 s
(`AUTH_RECHECK_SECONDS`), also without client traffic. Close codes: `1008` for
missing/invalid/expired/revoked credentials, `1011` when the auth service (Redis)
is unavailable or times out (5 s).

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
  `AUTH_INVALID_CREDENTIALS`, `AUTH_USER_INACTIVE`, `AUTH_SESSION_EXPIRED`. 401 responses carry
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
`vendor`, `location`, `ping_status`, `ping_rtt_ms`, `ping_only`, `map_x`, `map_y`, `ignored`,
`label`, `enabled`, `vendor_override`, `latency_monitored` (opt-in for the latency
monitor in `latency_mode=selected`). Plus:

- `ping_only: bool` (default false): the device is monitored by ping only because
  its credential has `snmp_enabled=false` (see [Rack occupancy and ping-only devices](#rack-occupancy-and-ping-only-devices)).
- `id`, `last_seen`, `ports: PortOut[]`
- `rack_id`, `class_id`, `model_id`, `rack_u_position` (1..48 or null = not placed),
  `u_height` (default 1), `rack_side` (`front|rear`, default `front`), `full_depth`
  (bool, default false: occupies its U range on both sides)
- `floor_id`: floor of an unracked device, or null. A racked device's effective
  floor is its rack's `floor_id` (computed by the client); rack changes never
  modify `floor_id`.
- `ports_per_row`, `total_ports`: resolved from the assigned switch model
- `stp: StpInfo | null`: bridge-level spanning tree summary of the default instance.
  `StpInfo` = `protocol` (`stp|rstp|mstp|unknown`), `bridge_id`
  (`"<prio hex4>.<mac hex12>"`), `root_id`, `root_cost`, `root_port` (null on the
  root bridge), `is_root`. `null` when no STP data was collected. The raw
  `stp_*` device columns are input-only and excluded from the output.
- `vlan_names: {vlan_id_string: name}`: always an object (empty when unknown).
- `device_type`: `switch|firewall|ups|server|other` (default `switch`; ping-only
  devices are created as `other`). Derived during a
  scan from the detected vendor scanner (OPNsense `firewall`; Eaton / HPE UPS
  `ups`; HPE iLO `server`; a generic device answering RFC 1628
  `upsIdentManufacturer` `ups`). A generic switch fallback never overwrites a
  stored type, so a manual correction via the meta PATCH survives; with
  `vendor_override` set, only a still-default `switch` is upgraded by a confident
  detection.
- `health: object | null`: normalized SNMP health snapshot, collected on every
  non-discovery scan of a UPS or server (a failed collection keeps the previous
  snapshot). Every key is always present (`null` when not reported):
  - UPS: `{kind: "ups", status, manufacturer, model, software, battery_status
    (unknown|normal|low|depleted), seconds_on_battery, runtime_minutes,
    charge_percent, battery_temperature_c, output_source (other|none|normal|bypass|
    battery|booster|reducer|parallel_capacity|parallel_redundant|high_efficiency|
    maintenance_bypass|energy_saver), load_percent (max over output lines),
    input_voltage (first input line), alarms_present}`. Source: RFC 1628 UPS-MIB;
    Eaton XUPS-MIB / HPE CPQPOWER-MIB fill missing runtime, charge, load, source
    and ident values.
  - Server: `{kind: "server", status, overall, thermal, power_supply, fans,
    storage (each ok|degraded|failed|unknown), temperature_max_c,
    temperature_sensors, product_name, serial_number, ilo_firmware}` from the HPE
    CPQHLTH / CPQIDA / CPQSINFO / CPQSM2 MIBs.
  - `status`: `ok|warning|critical|unknown`. UPS: critical when the battery is
    depleted, no output source, or alarms with charge <= 20%; warning on battery,
    battery low, bypass or any alarm. Server: critical when any subsystem failed,
    warning when any is degraded.
- `health_updated_at`: naive UTC timestamp of the snapshot, or null.

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
`racks: RackOut[]`, `classes: SwitchClassOut[]`, `models: SwitchModelOut[]`,
`buildings: BuildingOut[]` (sorted by `sort_order`, then `id`; see the floors router).

### Rack occupancy and ping-only devices

Rack occupancy (shared rule in `backend/shared/rack_space.py`): a placed device or
rack item occupies `[rack_u_position, rack_u_position + u_height - 1]` on its
`rack_side`; with `full_depth=true` it occupies that range on both sides. Two
objects conflict iff their U ranges overlap and their occupied sides intersect
(a front and a rear object may share a U). Every placement write applies the rule:
`PATCH /racks/{id}/layout`, rack item create/update, `PATCH
/topology/devices/{id}/meta` and `PATCH /topology/devices/bulk-meta`. Conflicts
return `409`:

```json
{"error": {"code": "U_OVERLAP", "message": "Device 7 at U10-U11 (the front side) overlaps device 3",
           "details": [{"device_ids": [7, 3], "rack_item_ids": []}]}}
```

A placement that does not fit inside the rack returns `409 U_POSITION_OUT_OF_RANGE`.

Ping-only devices: a credential with `snmp_enabled=false` is never queried via
SNMP. Every scan (any type) pings it; when no device with that IP exists, one is
created regardless of the ping result (`sys_name` = credential label or the IP,
`sys_descr` "Ping-only device (SNMP disabled)", empty `vendor`, `device_type`
`other`, `ping_only=true`) and linked to the credential. An existing device only
gets `ping_only=true` and its ping state (`ping_status`, `ping_rtt_ms`,
`last_ping`, `last_seen` on a reply); name, vendor, rack, class and floor are
kept. When the IP also has an enabled SNMP credential, the SNMP credential wins.
After switching the credential back to `snmp_enabled=true`, the next scan clears
`ping_only` and runs the normal SNMP path. The latency monitor probes ping-only
devices like any other enabled, non-ignored device.

Ping candidates (table `ping_candidates`, migration 028): when a discovery or full
scan finishes without being cancelled, every discovery-range probe host that
answered ping but no SNMP profile, and has neither a device nor a credential, is
upserted as a candidate (`ip` unique, `rtt_ms`, `first_seen`, `last_seen`,
`dismissed`). A repeat sighting refreshes `last_seen` and `rtt_ms` and keeps
`dismissed`. Credential targets never become candidates. `GET /ping-candidates`
hides candidates whose IP meanwhile has a device or a credential.
`POST /credentials/ping-only` adopts hosts in bulk: per entry it creates a
credential (`snmp_enabled=false`, `enabled=true`, label or empty) and immediately
creates the ping-only device (`ping_status` `unknown` until the next scan) or marks
an existing device `ping_only` (metadata and ping state kept), links
`credential.device_id`, deletes the matching candidate and writes one audit entry
(`create` / `credential`, `details.ping_only=true`). The topology version is bumped
when anything was created.

### Secret masking

`CredentialOut` and `SnmpProfileOut` mask `community`, `v3_auth_password` and
`v3_priv_password` as `***`; config/bulk exports use `********`. Both sentinels sent
back on update mean "unchanged" and are never stored.

## Routers

Infrastructure routes are listed first, then the API routers in `main.py` mount
order. 22 router modules total (`health` and `ws` are unversioned).

### health (`routers/health.py`) -- unversioned

Component health for container healthchecks and monitoring.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/health` (no prefix) | public | Liveness: database (`SELECT 1`) and Redis ping. `200` when both are OK (Redis may be `not_configured`), `503` otherwise; a failed check reports `"error"` (exception only in the log). Does not ping Celery, so a missing worker never marks the backend container unhealthy. Used by the compose healthcheck. | `{"status": "ok"\|"degraded", "checks": {database, redis}}` |
| GET | `/health?deep=1` (no prefix) | any (bearer required, else `401 AUTH_REQUIRED`) | Readiness: as above plus a Celery worker ping (timeout 2 s). `503` also when no worker answers (`none`) or the broker is unreachable (`unreachable`) while Redis is configured. | `{"status", "checks": {database, redis, celery}, "workers": "ok"\|"none"\|"unreachable"\|"not_configured"}` |

### metrics (`main.py`) -- unversioned

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/metrics` (no prefix) | any | Prometheus exposition format. | text |

### ws (`routers/ws.py`) -- unversioned

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| WS | `/ws/scan-progress` (no prefix) | ticket or token in `?token=` | Real-time scan progress. See [WebSocket](#websocket-scan-progress). | JSON messages |

### settings (`routers/settings.py`)

Generic key/value app settings and dashboard statistics.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/settings` | any | List all app settings. | `AppSettingOut[]` |
| PUT | `/settings/{key}` | op+ | Upsert one setting. Only allowlisted keys (`ALLOWED_SETTING_KEYS`: discovery/link/mac/port/vlan/stp intervals, `discovery_scan_ranges`, `scan_max_workers`, `scan_snmp_timeout`, `scan_snmp_retries`, `scan_snmp_bulk_size`, `dns_servers`, `map_opacity`, `map_scale`, `map_bg_color`, `audit_retention_days`, `endpoint_retention_days` (integer 0-3650), and the latency keys `latency_enabled` (`true`/`false`), `latency_interval_sec` (5-300), `latency_pings` (1-10), `latency_mode` (`all`/`selected`), `latency_retention_days` (1-365)); others -> `400 UNKNOWN_SETTING_KEY`. Latency keys and `endpoint_retention_days` are validated and normalized; invalid values -> `400 INVALID_SETTING_VALUE`. 10/min. | `AppSettingUpdate` -> `AppSettingOut` |
| PUT | `/settings` | op+ | Atomic multi-key update: JSON object `{key: value}` (string values). Every key and value is validated first with the same rules as `PUT /settings/{key}` (`400 UNKNOWN_SETTING_KEY` / `400 INVALID_SETTING_VALUE`, `field` = offending key; empty object -> `400 EMPTY_SETTINGS`); nothing is written unless all are valid. One audit entry (`details.keys`). Shares the 10/min limit; one call counts once. | `{key: value}` -> `AppSettingOut[]` (all settings, like GET) |
| GET | `/stats` | any | Counts (devices, ports, ports up, racks, endpoints) and last scan time/status. | ad-hoc object |

### credentials (`routers/credentials.py`)

SNMP credentials (per IP or device, with priority and optional profile).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/credentials` | any | List credentials (secrets masked). | `CredentialOut[]` |
| POST | `/credentials` | op+ | Create credential; secrets encrypted with `ENCRYPTION_KEY`. Optional `snmp_enabled` (default true; false = ping-only host). | `CredentialCreate` -> `CredentialOut` (201) |
| PUT | `/credentials/{cred_id}` | op+ | Update; mask sentinels mean "unchanged". `snmp_enabled` optional (explicit null leaves it unchanged). | `CredentialUpdate` -> `CredentialOut` |
| DELETE | `/credentials/{cred_id}` | admin | Delete. | 204 |
| POST | `/credentials/ping-only` | op+ | Bulk-register ping-only hosts (see [Rack occupancy and ping-only devices](#rack-occupancy-and-ping-only-devices)). Body `{"entries": [{"ip", "label"?}]}`, max 500 entries (more -> 422). Each IP is validated like `CredentialCreate.ip`; skipped with reason `invalid` (bad IP), `exists` (any credential with that IP, enabled or not) or `duplicate` (repeat within the batch). 10/min. | -> `{"created": [{"ip", "credential_id", "device_id"}], "skipped": [{"ip", "reason"}]}` (200) |

### snmp_profiles (`routers/snmp_profiles.py`)

Reusable SNMP parameter sets (v2c community or v3 USM settings).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/snmp-profiles` | any | List profiles (secrets masked). | `SnmpProfileOut[]` |
| POST | `/snmp-profiles` | op+ | Create. | `SnmpProfileCreate` -> `SnmpProfileOut` (201) |
| PUT | `/snmp-profiles/{profile_id}` | op+ | Update; mask sentinels mean "unchanged". | `SnmpProfileUpdate` -> `SnmpProfileOut` |
| DELETE | `/snmp-profiles/{profile_id}` | admin | Delete; referencing credentials get `profile_id` null. | 204 |

### racks (`routers/racks.py`)

Physical racks and rack elevation layout.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/racks` | any | List racks. | `RackOut[]` |
| POST | `/racks` | op+ | Create (`height_u` 6..60, default 42; optional `floor_id`, unknown -> 404 `FLOOR_NOT_FOUND`). | `RackCreate` -> `RackOut` (201) |
| PUT | `/racks/{rack_id}` | op+ | Update. A `height_u` that would exclude a placed device or a rack item -> 409 `U_POSITION_OUT_OF_RANGE`. `floor_id`: unknown -> 404 `FLOOR_NOT_FOUND`, explicit null clears it (other null fields are ignored). | `RackUpdate` -> `RackOut` |
| DELETE | `/racks/{rack_id}` | admin | Delete; detaches its devices and deletes its rack items. | 204 |
| PATCH | `/racks/{rack_id}/layout` | op+ | Set U positions/heights (and optionally side/depth) of devices in this rack. Omitted devices stay in place; omitted `rack_side` / `full_depth` keep the stored values. Rejects duplicates and devices not in the rack (422), unknown devices (404), out-of-range placements and side-aware U overlaps with other devices or rack items (409 `U_POSITION_OUT_OF_RANGE`, `U_OVERLAP`). | `RackLayoutIn` `{entries: [{device_id, rack_u_position, u_height, rack_side?, full_depth?}]}` -> `{"updated": n}` |

### rack_items (`routers/rack_items.py`)

Manually maintained rack placeholders (patch panels, blanks, cable managers,
shelves) shown in the rack elevation. Placeholder only: no ports, no cabling,
no IP, never scanned. `kind` is one of `patch_panel` (default), `blank`,
`cable_manager`, `shelf`, `other`; `rack_u_position` is the 1-based bottom U
(1..48) and `u_height` 1..60; `rack_side` is `front` (default) or `rear`,
`full_depth` (default false) occupies both sides. Every placement must fit inside
the rack (409 `U_POSITION_OUT_OF_RANGE`) and must not conflict with placed devices
or other items under the side-aware rule (409 `U_OVERLAP`, see
[Rack occupancy](#rack-occupancy-and-ping-only-devices)). Writes bump the topology
version and are audit-logged (`rack_item`).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/racks/{rack_id}/items` | any | List the rack's items, top to bottom. Unknown rack -> 404 `RACK_NOT_FOUND`. | `RackItemOut[]` |
| POST | `/racks/{rack_id}/items` | op+ | Create an item. | `RackItemCreate` `{kind, label, rack_u_position, u_height, rack_side, full_depth, note}` -> `RackItemOut` (201, includes `rack_side`, `full_depth`) |
| PATCH | `/rack-items/{item_id}` | op+ | Partial update; explicit null is ignored except for `note` (clears it). Unknown item -> 404 `RACK_ITEM_NOT_FOUND`. | `RackItemUpdate` -> `RackItemOut` |
| DELETE | `/rack-items/{item_id}` | op+ | Delete an item. | 204 |

### floors (`routers/floors.py`)

Buildings and their floors for the topology map (migration 026). Every floor has
its own background image (stored as `/data/floor-<id>-background.<ext>`) and
background settings. Racks (`floor_id`) and unracked devices (`floor_id`) are
assigned to floors; a racked device's effective floor is its rack's floor. Writes
bump the topology version and are audit-logged (`building`, `floor`,
`floor_background`). Buildings and floors are ordered by `sort_order`, then `id`.

Schemas:

- `BuildingOut`: `id`, `label`, `description` (nullable), `sort_order`,
  `floors: FloorOut[]`.
- `FloorOut`: `id`, `building_id`, `label`, `sort_order`, `has_background`,
  `bg_version` (incremented on every background upload/delete; use it as a cache
  buster), `bg_opacity`, `bg_scale`, `bg_color`.
- `BuildingCreate` `{label (1..120 chars), description?, sort_order? = 0}`;
  `BuildingUpdate` all optional (explicit null clears `description`, other nulls
  are ignored).
- `FloorCreate` `{label (1..120 chars), sort_order? = 0}`; `FloorUpdate`
  `{label?, sort_order?, building_id?, bg_opacity? (0..1), bg_scale? (0.1..10),
  bg_color? (max 20 chars)}`; out-of-range values -> 422, explicit nulls are ignored.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/buildings` | any | List buildings with their floors. | `BuildingOut[]` |
| POST | `/buildings` | op+ | Create a building. | `BuildingCreate` -> `BuildingOut` (201) |
| PATCH | `/buildings/{building_id}` | op+ | Partial update. Unknown -> 404 `BUILDING_NOT_FOUND`. | `BuildingUpdate` -> `BuildingOut` |
| DELETE | `/buildings/{building_id}` | admin | Delete with all floors; racks/devices on them get `floor_id` null; background files are deleted. | 204 |
| POST | `/buildings/{building_id}/floors` | op+ | Create a floor. | `FloorCreate` -> `FloorOut` (201) |
| PATCH | `/floors/{floor_id}` | op+ | Partial update (also moves the floor to another building). Unknown floor -> 404 `FLOOR_NOT_FOUND`, unknown `building_id` -> 404 `BUILDING_NOT_FOUND`. | `FloorUpdate` -> `FloorOut` |
| DELETE | `/floors/{floor_id}` | admin | Delete; racks/devices on it get `floor_id` null; background file is deleted. | 204 |
| POST | `/floors/{floor_id}/background` | op+ | Upload/replace the floor background (multipart field `file`); same validation, sanitizing, size limit and 5/min rate limit as `POST /map-background`. Increments `bg_version`. | -> `FloorOut` |
| GET | `/floors/{floor_id}/background` | public (GET only) | Serve the floor background with the same headers and single-range rule as `GET /map-background`. `404 NO_BACKGROUND_IMAGE` when unset or the floor does not exist. | file |
| DELETE | `/floors/{floor_id}/background` | op+ | Remove the floor background. Increments `bg_version`. | -> `FloorOut` |

### switch_classes (`routers/switch_classes.py`)

Device classes (e.g. core/access) used for map styling and rack rules
(`allow_outside_rack`).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/switch-classes` | any | List. | `SwitchClassOut[]` |
| POST | `/switch-classes` | op+ | Create. | `SwitchClassCreate` -> `SwitchClassOut` (201) |
| PUT | `/switch-classes/{class_id}` | op+ | Update. | `SwitchClassUpdate` -> `SwitchClassOut` |
| DELETE | `/switch-classes/{class_id}` | admin | Delete; devices get `class_id` null. | 204 |

### switch_models (`routers/switch_models.py`)

Hardware models; provide `ports_per_row` and `total_ports` for port rendering.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/switch-models` | any | List. | `SwitchModelOut[]` |
| POST | `/switch-models` | op+ | Create. | `SwitchModelCreate` -> `SwitchModelOut` (201) |
| PUT | `/switch-models/{model_id}` | op+ | Update. | `SwitchModelUpdate` -> `SwitchModelOut` |
| DELETE | `/switch-models/{model_id}` | admin | Delete; devices get `model_id` null. | 204 |

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
| GET | `/scan-runs?limit=20` | any | Latest runs, newest `created_at` first (runs without a timestamp, stored before migration 023, sort last; limit clamped 1..200) with `new_devices`, `removed_devices`, `new_links`, `removed_links` diffed against the predecessor, plus per-switch metrics. | `ScanRunOut[]` |
| GET | `/scan-runs/{run_id}/dry-run-preview` | any | Stored dry-run preview for a run (`404 DRY_RUN_NOT_FOUND`). | JSON list (items shaped like `DryRunPreviewItem`) |

### topology (`routers/topology.py`)

Map data, device list and device metadata edits. Write operations bump the topology
version (invalidates the `GET /topology` ETag cache).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/topology` | any | Full map: non-ignored devices, links, racks, classes, models, buildings with floors. ETag/304. | `TopologyOut` |
| GET | `/devices` | any | All devices including ignored, ordered by IP. ETag/304. | `DeviceOut[]` |
| PATCH | `/topology/devices/{device_id}/position` | op+ | Persist drag-and-drop position. | `DevicePositionUpdate` `{map_x, map_y}` -> `DeviceOut` |
| PATCH | `/topology/racks/{rack_id}/position` | op+ | Persist rack position on the map. | `RackPositionUpdate` -> `RackOut` |
| PATCH | `/topology/devices/bulk-meta` | op+ | Bulk set `ignored`, `rack_id` / `clear_rack`, `class_id` (enforces `allow_outside_rack`), `floor_id` / `clear_floor` (unknown floor -> 404 `FLOOR_NOT_FOUND`), `rack_side`, `full_depth`. When `rack_id`, `rack_side` or `full_depth` change, the resulting placement of every listed device that keeps a U position is validated (side-aware, against the rack and each other): 409 `U_OVERLAP` / `U_POSITION_OUT_OF_RANGE`, nothing is written. | `BulkDeviceMetaUpdate` -> `{"updated": n}` |
| PATCH | `/topology/devices/{device_id}/meta` | op+ | Partial update of location, sys_name, vendor (sets `vendor_override`), model, rack/class/model ids, `floor_id` (explicit null clears, unknown -> 404 `FLOOR_NOT_FOUND`; rack changes keep it), ignored, label, enabled, `rack_u_position` (null unplaces), `u_height`, `rack_side` (`front|rear`), `full_depth`, `vendor_override`, `latency_monitored`, `device_type` (`switch|firewall|ups|server|other`, other values 422). When the device ends up placed in a rack and any of `rack_id`, `rack_u_position`, `u_height`, `rack_side`, `full_depth` is sent, the placement is validated first: 409 `U_OVERLAP` (side-aware conflict with a device or rack item) or 409 `U_POSITION_OUT_OF_RANGE`; nothing is written. Audit-logged with the changed field names. | `DeviceMetaUpdate` -> `DeviceOut` |

### map_bg (`routers/map_bg.py`)

Deprecated since migration 026: use the per-floor endpoints of the floors router.
These endpoints keep working and operate on the default floor = the first floor
ordered by building (`sort_order`, `id`), then floor (`sort_order`, `id`). The
image is stored as `/data/floor-<id>-background.<ext>` in the backend container;
opacity/scale/color are the floor's `bg_opacity`/`bg_scale`/`bg_color`. Without
any floor, `GET /map-background` returns 404 and `GET /map-settings` the defaults
(`0.3`, `1.0`, `#020817`); `POST /map-background` and `PUT /map-settings` first
create a building "Main building" with a floor "Ground floor".

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| POST | `/map-background` | op+ (token required although the path is auth-exempt) | Deprecated. Upload/replace (multipart field `file`). Allowed: png, jpeg, gif, webp (magic-byte check) and SVG (sanitized against an element allowlist). Max 20 MB (`FILE_TOO_LARGE`, `shared/file_settings.py`); nginx allows bodies up to 25 MB. 5/min. | -> `{ok, filename, size}` |
| GET | `/map-background` | public | Deprecated. Serve the default floor's image (`Content-Security-Policy: script-src 'none'`). Single byte range only (`416` otherwise). `404 NO_BACKGROUND_IMAGE` when unset. | file |
| DELETE | `/map-background` | admin (token required) | Deprecated. Remove the default floor's image. | -> `{ok}` |
| GET | `/map-settings` | any | Deprecated. Default floor's background opacity, scale, color. | `MapSettingsOut` |
| PUT | `/map-settings` | op+ | Deprecated. Update (opacity clamped 0..1, scale 0.1..10, color max 20 chars). | `MapSettingsUpdate` -> `MapSettingsOut` |

### scan_settings (`routers/scan_settings.py`)

Scan tuning, discovery ranges and DNS resolvers.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/scan-settings` | any | Current values. | `ScanSettingsOut` `{max_workers, snmp_timeout, snmp_retries, snmp_bulk_size, endpoint_retention_days}` |
| PUT | `/scan-settings` | op+ | Update (clamped: workers 1..128, timeout 1..30, retries 0..10, bulk size 5..100 = GETBULK rows per request, default 25; `endpoint_retention_days` 0..3650, default 30, 0 disables). After a successful full scan, endpoints whose `last_seen` is older than `endpoint_retention_days` are deleted; ignored endpoints and endpoints with notes are kept. | `ScanSettingsUpdate` -> `ScanSettingsOut` |
| GET | `/discovery-ranges` | any | IP/CIDR ranges for discovery. | `DiscoveryRangesOut` `{ranges}` |
| PUT | `/discovery-ranges` | op+ | Replace ranges (`400 INVALID_IP_RANGE` on bad entries). | `DiscoveryRangesUpdate` -> `DiscoveryRangesOut` |
| GET | `/dns-settings` | any | DNS servers for PTR lookups. | `DnsSettingsOut` `{servers}` |
| PUT | `/dns-settings` | op+ | Replace DNS servers. | `DnsSettingsUpdate` -> `DnsSettingsOut` |

### bulk (`routers/bulk.py`)

CSV/JSON export and import of credentials and SNMP profiles. `kind` is
`credentials` or `profiles`. Credential rows include `snmp_enabled`; a missing or
empty value on import means `true` (older exports stay SNMP credentials).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/bulk-export/{kind}?fmt=json\|csv` | op+ | Export with secrets masked (`********`). | `BulkExportOut` `{type, format, data}` |
| POST | `/bulk-import/{kind}` | admin | Validate and import rows; `dry_run` defaults to `true`. `data` max 10 MB (`422`). | `BulkImportRequest` `{format, data, dry_run}` -> `BulkImportResult` |

### config (`routers/config.py`)

Global configuration export/import (app settings, profiles, credentials).
Credential rows include `snmp_enabled` (missing on import -> `true`). Racks, rack
items and device placement are not part of this export.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/config/export` | op+ | JSON string with `version`, `exported_at`, `settings`, `profiles`, `credentials` (secrets masked; FK references also as `profile_label` / `device_ip`). 10/min. | `GlobalConfigExportOut` `{data}` |
| POST | `/config/import` | admin | Validate and import an export payload; `dry_run` defaults to `true`. `data` max 10 MB (`422`). | `GlobalConfigImportRequest` `{data, dry_run}` -> result object (no `response_model`) |

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
| POST | `/auth/refresh` | public (needs current token in header) | Refresh a valid or up to 1 h expired token; rotates (old `jti` blacklisted with Redis); `401 AUTH_SESSION_EXPIRED` after `JWT_MAX_SESSION_HOURS` since login. 10/min. | -> `TokenResponse` |
| GET | `/auth/me` | any | Current user from the token. | `{id, username, role}` |
| POST | `/auth/ws-ticket` | any | Issue a 30 s single-use WebSocket ticket (needs Redis). | -> `{ticket}` |
| POST | `/auth/logout` | any | Blacklist the current token; without Redis revoke all sessions of the user (see [Login and refresh flow](#login-and-refresh-flow)). | -> `{status: "ok"}` or `{status: "ok", revoked: "all_sessions"\|"none"}` |
| POST | `/auth/revoke-all` | admin | Revoke all sessions of `user_id` (body `{"user_id": n}`), or of the caller when omitted. Unknown user -> `404 USER_NOT_FOUND`. | -> `{status, user_id}` |
| GET | `/users` | admin | List users. | `UserOut[]` |
| POST | `/users` | admin | Create user (password 8 chars to 72 bytes, default role `viewer`). 10/min. | `UserCreate` -> `UserOut` (201) |
| PUT | `/users/{user_id}` | admin | Update email/password/role/is_active (same password rule). Revokes sessions on password, role or deactivation change (database, no Redis needed). Cannot demote/deactivate yourself or the last active admin (`CANNOT_MODIFY_SELF`, `LAST_ADMIN`). 10/min. | `UserUpdate` -> `UserOut` |
| DELETE | `/users/{user_id}` | admin | Delete user (same lockout guards); the user's tokens are rejected afterwards. 10/min. | 204 |

### audit (`routers/audit.py`)

Audit trail of write operations (`shared/audit.py`). User, credential and SNMP
profile writes and config/bulk imports write their entry in the same transaction
(strict mode): if the audit write fails, the request fails with `500` and nothing
is changed. Other writes log audit failures and continue.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/audit-logs?limit=100` | admin | Newest entries first (limit 1..500). | `AuditLogOut[]` |
| DELETE | `/audit-logs/purge?days=` | admin | Delete entries older than `days`. Default: the `audit_retention_days` app setting when it is a positive integer, else `AUDIT_RETENTION_DAYS` (env, default 90); same resolution as the scheduled purge (`shared/audit.py:get_audit_retention_days`). | -> `{deleted, cutoff}` |

### endpoints (`routers/endpoints.py`)

End hosts (MAC/IP/hostname) learned from switch forwarding tables, with the ports
they were seen on.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/endpoints?limit=&offset=` | any | Endpoints ordered by MAC. Without parameters the full list. With `limit` (1..10000) and/or `offset` (>= 0) one page plus header `X-Total-Count` (total endpoints). ETag/304 per page. | `EndpointOut[]` |
| GET | `/endpoints/{endpoint_id}` | any | One endpoint. | `EndpointOut` |
| PATCH | `/endpoints/bulk` | op+ | Bulk set `ignored`. | `BulkEndpointUpdate` -> `{"updated": n}` |
| PATCH | `/endpoints/{endpoint_id}` | op+ | Update `ignored` / `notes`. | `EndpointUpdate` -> `EndpointOut` |
| DELETE | `/endpoints/{endpoint_id}` | admin | Delete. | -> `{"deleted": true}` |

`EndpointOut`: `id`, `mac`, `ip`, `hostname`, `first_seen`, `last_seen`, `ignored`,
`notes`, `found_on: EndpointPortInfo[]` (`port_id`, `switch_ip`, `switch_name`,
`port_name`, `vlan_id`, `last_seen`).

### ping_candidates (`routers/ping_candidates.py`)

Discovery-range hosts that answered ping but no SNMP profile, offered for adoption as
ping-only devices (see [Rack occupancy and ping-only devices](#rack-occupancy-and-ping-only-devices)).

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/ping-candidates` | any | Non-dismissed candidates whose IP has no device and no credential, sorted by IP (numeric). `?include_dismissed=true` also returns dismissed ones. | `PingCandidateOut[]` |
| POST | `/ping-candidates/dismiss` | op+ | Set `dismissed=true`; `n` counts rows that changed (unknown or already dismissed ids are ignored). Audit `dismiss` / `ping_candidate`. | `{"ids": [int]}` -> `{"dismissed": n}` |
| POST | `/ping-candidates/restore` | op+ | Set `dismissed=false`; `n` counts rows that changed. Audit `restore` / `ping_candidate`. | `{"ids": [int]}` -> `{"restored": n}` |

`PingCandidateOut`: `id`, `ip`, `rtt_ms` (null when unknown), `first_seen`, `last_seen`,
`hostname`, `mac`, `vendor`, `dismissed` (always present). `hostname` and `mac` come from
the most recently seen endpoint with the same IP (`endpoints.hostname`, `endpoints.mac`;
null without one). `vendor` is currently always null (endpoints store no OUI vendor).

### latency (`routers/latency.py`)

Network latency monitor. Data comes from the `latency-monitor` service (see
`docs/OPERATIONS.md`): live per-device state in Redis, per-minute rollups in the
`latency_samples` table.

| Method | Path | Role | Description | Schema |
|---|---|---|---|---|
| GET | `/latency/summary` | any | Current network and per-device latency. | `LatencySummaryOut` |
| GET | `/latency/history` | any | Time series; query `range=1h\|24h\|7d` (default `1h`, other values -> 422), optional `device_id` (unknown -> `404 DEVICE_NOT_FOUND`). | `LatencyHistoryOut` |

`LatencySummaryOut`: `enabled`, `interval_sec`, `mode` (`all|selected`),
`monitor_alive` (monitor heartbeat younger than `max(30 s, 3 x interval)`),
`updated_at` (ISO or null), `network` {`median_ms`, `p95_ms` (over device `rtt_ms`),
`loss_pct` (mean device loss), `targets`, `reachable` (status not `down`/`unknown`),
`degraded` (status `degraded`/`loss`/`down`)}, `devices[]` {`device_id`, `name`
(label, sys_name or ip), `ip`, `rtt_ms` (median of the last 6 probes), `jitter_ms`,
`loss_pct`, `baseline_ms` (median of the last 24 h minute averages, null below 30
values), `status` (`ok|degraded|loss|down|unknown`), `updated_at`}.

- `devices` lists the current targets (enabled, not ignored, opted in for
  `selected` mode, max 200); targets without data yet are `unknown`. Sorted by
  severity (down, loss, degraded, ok, unknown), then `rtt_ms` descending. Empty when
  `latency_enabled=false`.
- Status: `down` = 100 % loss, `loss` > 5 %, `degraded` = `rtt_ms > max(3 x
  baseline, baseline + 5 ms)`, else `ok`.
- While `monitor_alive` is false every device is reported `unknown` with null
  `rtt_ms`/`jitter_ms`/`loss_pct` (`baseline_ms` and `updated_at` kept as "last
  seen"); network `median_ms`/`p95_ms`/`loss_pct` are null, `reachable`/`degraded` 0.
- Without Redis the summary uses the newest rollup per device of the last 5 minutes
  (`baseline_ms` null, `monitor_alive` = a rollup younger than 3 minutes).

`LatencyHistoryOut`: `range`, `device_id` (or null), `bucket_sec` (1h: 60, 24h:
300, 7d: 1800), `points[]` {`ts` (bucket start, ISO UTC), `rtt_ms`, `jitter_ms`,
`loss_pct`}. With `device_id`: means of that device's rollups per bucket. Without:
network series, per bucket the median across devices of their mean `rtt_ms` /
`jitter_ms` and the mean of their loss. Only buckets with data, ascending.

## Open points

- Responses without a `response_model` (`/stats`, `/auth/me`, scan job endpoints,
  `/logs`, `/config/import`, dry-run preview) are not typed in OpenAPI; their shape
  is defined only by the router code.
