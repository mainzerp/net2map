# Decisions

## Setup decisions (2026-09-15)

- **Brain created; AGENTS.md adapted.** `brain/roadmap.md` is the live pipeline board;
  `todo.md` is frozen as a legacy checklist and points here. Reason: one pipeline
  owner, no double bookkeeping. (2026-10-06: `todo.md` removed in the repo cleanup.)
- **Doc map.** `docs/README.md` created as the doc map. `docs/SubAgent/` keeps AI-agent
  ANALYSIS/PLAN working notes (session artifacts, not maintained user docs).
  `README.md` and `BACKUP.md` stay German because they are user-facing; agent-facing
  docs (brain, docs/README.md) are English; code and comments are always English.
- **Verification commands** (must pass before a task is declared done):
  `ruff check backend/`, `cd backend && python -m pytest tests/ -v`,
  `cd frontend && npm run typecheck`, `cd frontend && npm test`.
- **Commits.** Conventional Commits codified going forward: types `feat`, `fix`,
  `chore`, `docs`, `refactor`, `test`, `release`; scopes `backend`, `frontend`, `ci`,
  `docs`, `release`. History was loose (mixed prefixes); new commits follow the
  convention. Direct commits to `main`, no PR flow -- unchanged.
- **Intake.** None; the user reports tasks directly. The external-reports section was
  removed from AGENTS.md. The `workflows/` n8n export folder currently contains no
  workflows; purpose unconfirmed -- left untouched.
- **Version carrier.** `VERSION.md` (`## vX.Y.Z -- Title` headings with Type label).
  Not mirrored in code; the `frontend/package.json` version (1.0.0) is stale and
  ignored. Git tags `v*` drive CI image pushes to `ghcr.io/mainzerp/netmap`.
- **jcodemunch repo id.** `mainzerp/netmap` (derived from the git remote; the local
  folder is `switch-map`).

## Firmware version source (2026-09-20)

- **ENTITY-MIB first, sysDescr fallback.** Firmware comes from
  `entPhysicalSoftwareRev.1` (appended to the existing system-scalar GET, so no extra
  round trip); if the device does not answer it, the vendor scanner's
  `extract_version(sys_descr)` parses it out of sysDescr. Reason: one OID works on
  most managed switches, but several vendors only carry the version in sysDescr —
  the fallback keeps coverage without per-vendor OID tables.

## Credential masking contract (2026-09-20)

- **Mask sentinels.** API responses mask `community`, `v3_auth_password` and
  `v3_priv_password` as `"***"`; config/bulk exports use `"********"`. Backend update
  paths treat both sentinels as "unchanged" and must never encrypt/store them; insert
  paths normalize masked values to `""`. Frontend edit forms map `"***"` to `""` and
  omit empty secret fields on submit. Reason: the old round-trip silently destroyed
  SNMPv3 passwords on any unrelated edit.
- **Viewer is read-only** for device/rack positions, bulk export and `/api/logs`
  (admin/operator required). `/api/auth/refresh` enforces token blacklist and user
  revocation; the legacy static token only works when no `JWT_SECRET` is configured.
- **Scan lock** uses a UUID owner token with compare-and-delete release and periodic
  renewal (TTL 600s was shorter than real scan durations); manual scans acquire the
  same lock as scheduled ones.
- **Vendor override is a real flag.** `devices.vendor_override` (migration 014) is set
  when a user edits `vendor` via the device-meta endpoint and cleared when the vendor
  is emptied; the scan executor only honors a DB vendor when the flag is set,
  otherwise auto-detection wins. Bulk import/export matches credentials on
  `(ip, priority)`, matching the unique constraint.

## Frontend rework (v2.0.0)

- **Tailwind v4 token-based styling** replaces inline styles: theme tokens in
  `src/index.css` (dark default, light via `[data-theme="light"]`), semantic
  utilities (`bg-surface`, `text-primary`, `border-line`). Reason: one theme
  source, free dark/light switching, no per-component hex drift.
- **@xyflow/react + dagre for the topology map** (`src/features/topology/`).
  Reason: the hand-rolled SVG map could not deliver auto-layout, minimap, zoom
  controls and group nodes without growing unmaintainable.
- **TanStack Query as the data layer** (`src/hooks/api/`, QueryClientProvider in
  `main.tsx`). Reason: polling, caching and invalidation were re-implemented per
  page; the store now only holds UI selection state.
- **True U-based rack model** (migration 015: `Rack.height_u`,
  `Device.rack_u_position`, `Device.u_height`, `PATCH /api/racks/{id}/layout`)
  over the list-based rack panel ordering. Reason: the elevation view needs real
  U positions (U1 bottom, overlap detection); list order cannot express that.

## Review hardening (2026-10-01)

- **Durable session revocation is required for security mutations.** Configured
  Redis outages fail JWT verification closed; unavailable revocation prevents
  account security changes from committing. No process-local fallback: it would
  lose revocations on restart and disagree across workers. README owns operations.
- **Session boundaries invalidate frontend state.** Logout clears credentials
  immediately; login/logout/401 clear query and ETag caches. Requests and refreshes
  from an earlier session cannot restore its state.
- **Proxy trust starts at the bundled nginx edge.** Discard incoming forwarded-IP
  chains by default so clients cannot choose their rate-limit identity. Deployments
  with another proxy must explicitly configure trusted peers.
- **Rack PATCH validates the resulting layout.** Omitted devices retain their
  positions, so overlap checks include them; shrinking cannot truncate occupancy.

## Security remediation and CI gate (2026-10-01)

- **Dependency migrations are authorized.** Replace the incompatible legacy
  SNMP driver and upgrade the frontend toolchain/router rather than excluding
  advisory IDs. Preserve scan behavior and routing with import, transport and UI
  regression checks.
- **Security failure blocks image builds and publication.** The workflow must
  require successful dependency and static scans before either Docker job. Scan
  errors also block; dependency policy includes development packages and every
  reported severity. README owns the concrete commands and operating contract.
- **Intentional SNMP compatibility is explicit.** NetMap continues supporting
  user-selected v2c and v3 without privacy. Only the corresponding Bandit
  compatibility branches may carry rule-specific rationale; no global rule or
  dependency-advisory suppression. Recommend SNMPv3 authPriv for deployments.
- **Redis failure cannot create a second local scan owner.** Local locks are
  reserved for intentionally Redis-free operation; configured outages fail closed.
  Scan tasks own and drain their network/finalization work, with lease checks at
  transaction boundaries. Redis/SQL atomic fencing remains a separate design.
- **Live sockets share a bounded revalidation deadline.** A watchdog covers idle
  connections while broadcasts reuse the same check deadline. Single-use tickets
  are not consumed twice. Redis I/O has finite timeouts so outages cannot leave
  authentication checks waiting indefinitely.

## UI redesign direction (2026-10-05)

- **Visual language follows Billio (warm paper, ink navy, terracotta accent).** The
  previous palette was stock Tailwind slate/cyan and read as a generic admin template.
  Light "paper" is the default theme; dark is a derived "ink night" variant.
- **Typography stays plain: system font stack, no web fonts.** Character comes from
  color, layout and the map, not a display face; also drops the Google Fonts dependency.
- **Prototype first.** A /styleguide page and the redesigned dashboard are reviewed
  before the shell, map, racks and motion are rebuilt.
- **One inspector drawer, addressed by URL.** `?inspect=device:<id>|endpoint:<id>|rack:<id>`
  on any route opens a shared right-side drawer rendered by the shell: deep-linkable,
  closes with Back, and replaces page-local detail state (MapPage `detailSwitchId`).
- **Command palette without a new dependency.** Ctrl/Cmd+K searches the already cached
  `useTopology` + `useEndpoints` data with hand-rolled fuzzy scoring; there is no backend
  search endpoint and the lists are small enough for client-side matching.
- **Auto-Layout only without a floor-plan background.** The map's value is nodes
  placed by hand on the uploaded plan; a full re-layout would destroy that. The
  function stays for maps without a background image.

## API versioning and SNMPv3 engine ID (2026-10-05)

- **Routers are versioned for real, not by path rewriting.** Route decorators drop
  the literal `/api` prefix; every router is included under `/api/v1` (canonical,
  in OpenAPI) and again under `/api` as a deprecated alias (`include_in_schema=False`,
  `Deprecation` + `Link: rel="successor-version"` headers). A future `/api/v2` can
  then diverge per router. `/health`, `/metrics` and `/ws/*` stay unversioned.
  The frontend client maps its logical `/api/...` paths to `/api/v1` centrally in
  `src/api.ts`, so call sites and test mocks keep their logical paths.
- **SNMPv3 engine ID: observe, do not pin.** PySNMP performs RFC 3414 discovery
  per engine. The discovered authoritative engine ID is stored per credential for
  display and change detection (audit/log when it changes, e.g. device replaced);
  it is not fed back into requests, because a pinned stale ID would break scans
  after a replacement. A manual `v3_engine_id` override on the credential is
  applied as `securityEngineId` only when set. Verified: PySNMP 7 still sends its
  discovery probe with an override, so it does not help agents that ignore
  discovery; it only fixes the engine ID keys are localized to.
  Context engine ID / context name stay out of scope until a device needs them.

## Logical topology overlays (2026-10-06)

- **STP and VLAN ship together, one map "Layer" switch.** Toolbar control with
  `Off | STP | VLAN`; VLAN mode adds a single-VLAN picker. Matching links/devices
  are emphasized, everything else fades. One VLAN at a time, because striping all
  VLANs per link becomes unreadable on real trunks.
- **STP from standard MIBs only.** BRIDGE-MIB `dot1dStp*` (bridge/root ID, root
  cost, root port, per-port state, path cost) plus RSTP-MIB `dot1dStpVersion` for
  the protocol. Port role is derived (`root` = root port, `blocked` = blocking or
  discarding, `designated` = forwarding otherwise, `disabled`), because RSTP-MIB has
  no role column. MSTP switches (Aruba CX, FS) report the CIST through BRIDGE-MIB.
  Cisco PVST+/Rapid-PVST exposes per-VLAN instances only via community/context
  indexing; v1 reads the default instance (VLAN 1) and records that limitation.
  Collection is best effort: missing MIB subtrees leave the fields null and never
  fail a scan.
- **Data contract.** `PortOut.stp_state` (`disabled|blocking|listening|learning|
  forwarding|broken`, null if unknown), `PortOut.stp_role` (`root|designated|
  blocked|disabled`, null). `DeviceOut.stp` (null if no STP data) with `protocol`
  (`stp|rstp|mstp|unknown`), `bridge_id` and `root_id` as `"<prio hex4>.<mac12>"`,
  `root_cost`, `root_port` (port name), `is_root`. `DeviceOut.vlan_names` maps VLAN
  id strings to names (empty object if unknown). Links stay name-matched to ports,
  as in `graph.ts`.
- **One stable color per VLAN id.** `vlanColor(id)` in `src/features/topology/vlanColor.ts`
  derives an OKLCH hue from the id (step ~-23.08 deg, compressed into 60..350 deg so
  the terracotta/danger band 350..60 stays free); lightness/chroma are theme tokens
  (`--vlan-l/-c/-soft-l/-soft-c`) holding >= 4.85:1 on all surfaces. The golden angle
  was rejected: it puts common ids (10/99, 1/200) almost on the same hue.

## SNMP scan load (2026-10-06)

- **Interface names are cached, status and speed are always walked.** ifDescr/ifAlias
  are static, so link/MAC scans read them from `devices.if_names` (ifIndex ->
  [descr, alias]) and only walk ifOperStatus/ifHighSpeed. The cache is fresh for one
  discovery interval (1800 s when discovery is disabled); any ifIndex missing from the
  cache triggers a full name walk, and manual full/ports scans always walk. Rejected:
  "walk once, then GET known OIDs" for FDB/ARP/LLDP -- their rows are the data, so new
  endpoints or neighbors would never be found; for stable columns GETBULK already
  needs about as few round trips as GET.
- **GETBULK size is a scan setting** (`scan_snmp_bulk_size`, 5..100), applied per scan
  through a ContextVar in `snmp_scanner` instead of threading a parameter through
  every walk. Default stays 25 so existing installs behave unchanged; larger values
  are opt-in because weak agents can answer large bulk requests with errors, which
  ends a walk early.
- **VLAN and STP have their own refresh intervals, piggybacked on MAC scans**
  (`vlan_update_interval_sec` default 1800, `stp_update_interval_sec` default 300,
  0 = manual full scans only). MAC scans rebuild the port rows, so they are the only
  scheduled scans that can store per-port VLAN/STP data; when a part is not due, the
  rebuild copies the previous port values (by ifIndex) and the device summary stays.
  Link scans no longer walk VLAN/STP at all (they discarded the per-port data anyway).
  Rejected: separate scheduled "vlan"/"stp" scan types -- new lock priorities, task
  routing, API scan types and in-place port updates for little gain. Consequence: the
  effective refresh is rounded up to the MAC interval and stops when MAC polling is
  disabled.
- **Interval fallbacks match the seeds** (links 60 s, MACs 300 s); the old 30 s
  fallback only applied when the settings rows were missing.

## Rebranding to Net2Map (2026-10-06)

- **Name: Net2Map.** Research found "NetMap" heavily used, including same-domain
  tools (xoriin/NetMap, opennetworktools/netmap, FreeBSD netmap) and live US marks;
  "NetworkAtlas"/"NetAtlas" collide with SolarWinds, Zyxel and natlas. "Net2Map" had
  no active collision and keeps continuity; "TopologieAtlas" was the alternative.
  Trademark and domain checks were web-search only, not registry queries.
- **Full rename including runtime identifiers** (user choice), released as MAJOR
  v3.0.0: containers, volumes, network, DB name/role, Redis prefix, Celery app,
  metrics, env var `NET2MAP_VERSION`, GHCR path. Supersedes the `netmap` names in
  older entries above (ghcr path, Redis keys, jcodemunch repo id once the repo is
  renamed).
- **Compose project name pinned (`name: net2map`)** with short volume keys
  (`pgdata`, `redisdata`, `data` -> `net2map_*`). Reason: image and volume names no
  longer depend on the checkout folder, which also fixes CI tagging
  (`net2map-backend`) and the demo override image names.
- **Data carry-over is manual, not automatic**: dump/restore for Postgres (new role
  name), volume copy for Redis and map data, documented in `docs/OPERATIONS.md`.
  Old volumes stay untouched for rollback. Automatic code-side shims only where
  cheap and safe: Redis `RENAMENX netmap:* -> net2map:*` at backend start, and a
  one-time localStorage key copy in `frontend/src/storageMigration.ts`.

## Backlog sweep (2026-10-06)

- **Scan lock fencing in the database.** Acquiring `scan:lock` atomically
  increments `netmap:fence:scan:lock` (one Lua script) and the lock token becomes
  `<owner>:<fence>`. Every transaction under `@_guard_scan_transactions` first
  upserts `lease_fences` with `ON CONFLICT ... WHERE token <= excluded.token`;
  zero rows means a newer holder exists, so the transaction rolls back with
  `StaleLeaseError` (a `ScanOwnershipLost`). The counter is floored at Redis time
  in microseconds so a Redis data loss cannot restart tokens below the stored
  fence and block all future scans. Redis checks stay as the cheap early exit.
- **sysObjectID matching respects OID boundaries** and the longest prefix wins.
- **`/health` is liveness only (DB + Redis).** It is the container healthcheck,
  so a missing Celery worker must not block the frontend; `/health?deep=1` adds
  the worker ping and returns 503 without workers.
- **OpenAPI UI public by default** (`OPENAPI_ENABLED=true`): the pages are static
  and every API call still needs a bearer token. The docs paths get their own CSP
  (jsDelivr assets plus the inline-script hash), the SPA keeps its strict CSP.
- **Logout validates its own token** and is exempt from the global auth
  dependency, so logging out with an expired or revoked token is idempotent (200)
  while garbage tokens get 401.
- **Scheduler and rate limits are shared through Redis**, with in-memory fallback
  when Redis is unavailable, so multiple workers no longer dispatch or count twice.

## Network latency monitor (2026-10-08)

- **Dedicated `latency-monitor` compose service** (backend image, `python -m
  latency.monitor`) instead of the API lifespan or Celery: uvicorn may run several
  workers (duplicate loops), and Celery slots are shared with scans. A Redis lock
  (`net2map:latency:monitor_lock`) keeps it single-instance.
- **Probing with the existing `iputils-ping`** (`-c N -i 0.2 -W 1 -q`, summary line
  gives avg and mdev as jitter): no new dependency, no `CAP_NET_RAW`.
- **Fixed targets, not random ones**: all enabled devices by default, or only devices
  with `latency_monitored` (mode `selected`). Random targets make the average move
  without any network change.
- **Storage split**: live state and a ~1 min rolling window in Redis, minute rollups
  in `latency_samples` (migration 022, default retention 30 days).
- **Status relative to a per-device baseline** (median of the last 24 h, needs 30
  minutes of data): `down` 100 % loss, `loss` > 5 %, `degraded` median > max(3x
  baseline, baseline + 5 ms). A network-wide mean hides single bad uplinks, so the
  per-device view and the topology layer are the primary signals.
- **Frontend polls** the summary at the probe interval; no WebSocket stream for
  10 s granularity data.
