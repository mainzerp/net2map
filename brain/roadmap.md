# Roadmap

Board format: headings are columns, `- title · priority: ... · area: ...` lines are
cards. Short indented lines under a card carry outcome, next step, or verification.

## Backlog

- Token storage in localStorage (review #32) · priority: P3 · area: frontend
  Deferred design decision: move the JWT to an httpOnly cookie (needs CSRF design).
- Frontend major upgrades (Vite, React Router) · priority: P3 · area: frontend
  Advisory residue from the October review; separate migration effort.
- Cisco PVST per-VLAN STP instances · priority: P3 · area: backend
  Needs community@vlan / v3 context `vlan-<id>` walks per VLAN.

## In Progress

(none)

## Testing

- Code review hardening (unreleased, MAJOR v4.0.0, migration 029) · priority: P1 · area: full-stack
  Fixes from the 2026-10-14 review: mandatory secrets, DB-backed revocation, refresh
  rotation, FK SET NULL, endpoint retention, scan loop off sync Redis/DB, LLDP ifIndex
  mapping, MAC decoding, scheduler/queue fixes, backup/restore, nginx, CI migration job,
  frontend hooks refactor. SECRET_TOKEN and the access-token login removed completely (compose, CI, backend, UI).
  Passed: ruff, 1012 backend tests, alembic upgrade/check/
  downgrade on postgres:16 (Docker), typecheck, frontend tests.
  Not verified: real switches (LLDP mapping, raw MAC walks), GitHub Actions run, browser.
  User to verify: set JWT_SECRET/ENCRYPTION_KEY, local build, login/logout/refresh,
  credentials still decrypt after upgrade, scan with LLDP neighbours shows correct
  local ports, map height on mobile, Settings > Scan endpoint retention saves.

- Adopt ping-only devices from endpoints and discovery candidates (unreleased, migration 028) · priority: P2 · area: full-stack
  `POST /credentials/ping-only` (bulk, creates credential + device at once); scan
  records range hosts with ping ok / SNMP failed in `ping_candidates`; endpoint
  inspector button, endpoint table bulk action, candidate list in Settings >
  Network Devices. Passed: ruff, 898 backend tests, typecheck, 346 frontend tests.
  Open: candidate `vendor` is always null (no OUI data), column shows empty;
  existing Ignore/Edit/Delete buttons are still visible to viewers.
  User to verify: local build, adopt an endpoint, set a discovery range, scan,
  candidates appear, adopt/dismiss/restore.

- Ping-only devices via credential flag (unreleased, migration 027) · priority: P2 · area: full-stack
  `credentials.snmp_enabled=false` -> scan only pings, creates a `ping_only` device
  (type `other`) even if unreachable; SNMP credential on the same IP wins.
  Passed: ruff, 882 backend tests, typecheck, 332 frontend tests.
  Open: "other" devices in a rack still get the port faceplate, not a plain plate.
  User to verify: local build, add a ping-only credential, scan, device appears with
  badge, rack/latency work.
- Rack front/rear side by side and full-depth (unreleased, migration 027) · priority: P2 · area: full-stack
  `rack_side` + `full_depth` on devices and rack items; shared rule in
  `backend/shared/rack_space.py`; `/meta` and `bulk-meta` now 409 on overlap.
  Open: bulk "assign to rack" keeps old U positions and may now 409; rack body
  narrowed to 440px; hatch styling not checked in a browser.
  User to verify: /racks, drag devices to Rear, toggle full depth, conflicts refused.
- Rack item palette with drag and drop (unreleased) · priority: P2 · area: frontend
  Palette above the tray replaces "+ Add item"; existing items draggable.
  User to verify: drag several patch panels into a rack, move one, click opens dialog.
- Rename Switches -> Devices, searchable assign picker (unreleased) · priority: P2 · area: frontend
  Settings tab "Network Devices"; `Combobox` primitive + `utils/deviceSearch.ts`.
  User to verify: Settings > Racks, type part of an IP, assign several in a row.

- Attention card ignores allow_outside_rack (released v3.5.0) · priority: P2 · area: frontend
  "N switches not assigned to a rack" counted every unracked device; now skips devices
  whose switch class has `allow_outside_rack` (classless unracked devices still count).
  Passed: AttentionCard tests, typecheck.
  User to verify: dashboard on the live stack after the next release.

- Buildings and floors on the topology map (released v3.5.0, migration 026) · priority: P2 · area: full-stack
  Buildings > floors (`/buildings`, `/floors/{id}`, per-floor background
  `/floors/{id}/background`, public GET); `floor_id` on racks and unracked devices;
  map floor switcher (`?floor=`), portal nodes for cross-floor links, "Unassigned"
  tab, per-floor viewport; Settings "Buildings & floors" replaces the Map tab; legacy
  `/map-background` + `/map-settings` deprecated (act on the first floor).
  Passed: ruff, 859 backend tests (7 snmp_driver local only), typecheck, 288 frontend
  tests; PostgreSQL upgrade smoke v3.4.0 -> local (025 -> 026): default building/floor
  created, rack assigned, background moved to `floor-1-background.png`, public GET 200.
  Open: config export still carries the unused `map_*` app_settings and no floors;
  portals use a fixed offset and can overlap; palette has no direct map focus.
  User to verify: smoke stack http://localhost:3300 (token login), create floors,
  upload plans, assign racks, check portals; then `docker compose -p net2map-smoke
  down -v` to remove it.

- Devices lose switch class membership (released v3.4.0) · priority: P1 · area: frontend
  Cause: `DeviceTable.submitEdit` always PATCHed `class_id` from a stale cache snapshot;
  `/meta` treats explicit null as unassign. Fix: only changed fields are sent.
  Passed: DeviceTable tests (rack-only edit omits class_id), backend meta test.
  User to verify: assign classes, add/edit a new switch in Devices, classes stay.
- Settings changes apply immediately (released v3.4.0) · priority: P2 · area: frontend
  Added invalidations (topology/devices/stats/credentials/all) in SwitchClasses,
  SwitchModels, Racks, Credentials ignore, ImportExport, SnmpProfiles tabs.
  User to verify: change a class color in Settings, map shows it without reload.
- Timestamps in browser local time (released v3.4.0) · priority: P2 · area: frontend
  `formatTimestamp`/`fmtTs` parse naive backend timestamps as UTC; LogsPage formats
  `entry.ts` (raw ISO in tooltip). Passed: datetime tests in any TZ.
  User to verify: Logs page times match the local clock.
- Patch panels as manual rack items (released v3.4.0, migration 024) · priority: P2 · area: full-stack
  `rack_items` table + `/racks/{id}/items`, `/rack-items/{id}`; kinds patch_panel,
  blank, cable_manager, shelf, other; overlap checks vs devices and items; "Add item"
  in the rack view. Passed: 11 backend + 10 frontend tests, typecheck.
  Open: topology `/meta` still allows placing a device onto an item (no U overlap
  check there at all); items not draggable (edit U position in dialog).
  User to verify: /racks, add a patch panel, drag a device onto it is refused.
- Remove devices from a rack (released v3.4.0) · priority: P2 · area: full-stack
  Drag a placed device onto the tray (drop zone highlighted) or use the hover "X"
  button on the faceplate / tray entry: `rack_id` and `rack_u_position` become null.
  Backend: clearing `rack_id` (single and bulk) now also clears the position.
  Passed: 8 frontend + 4 backend tests, typecheck, ruff.
  User to verify: /racks, drag a device onto the tray, it moves to "Unassigned".
- UPS (HPE/Eaton) and HPE servers via SNMP with status (released v3.4.0, migration 025) · priority: P2 · area: full-stack
  `device_type` + `health` JSON on devices; scanners eaton/hpe_ups/hpe_ilo; UPS-MIB
  probe for generic devices; inspector health section, rack health strip, map icons,
  dashboard attention rows; U stepper up to 10U. Passed: ruff, 833 backend tests
  (7 snmp_driver asyncore local only), typecheck, 254 frontend tests.
  Not verified against real hardware (OIDs checked against librenms MIBs only).
  User to verify: rebuild stack incl. workers, add credentials for a UPS and an iLO,
  run a scan, check inspector values and rack placement.

- Prebuilt images by default + local build override (released v3.3.0, 9ae8698) · priority: P2 · area: ci
  Done: `docker-compose.yml` runs GHCR images (`NET2MAP_VERSION`, default `latest`),
  `docker-compose.local.yml` builds the checkout under local image names, CI pushes
  `<tag>` + `latest`, `NET2MAP_PORT`, `docker-compose.ghcr.yml` removed, demo files
  git-ignored, all docs English. Passed: compose dry runs (prebuilt pulls 5 images,
  local builds 5), real local build, CI YAML parse.
  User to verify: after CI, `docker compose pull && docker compose up -d` on a fresh
  checkout starts v3.3.0 without building; the local command still builds.

- Demo data, screenshots, scan/worker fixes (released v3.2.1, bf3e5dd) · priority: P2 · area: full-stack
  Done: `seed_db.py` fills all pages + `--simulate-latency`; demo celery-beat
  scaled to 0; 14 screenshots in `docs/screenshots/` embedded in README; docs
  audit fixes (vendors, features, .env step, SECRET_TOKEN, router count, local
  override). Bug fixes: `ENV PYTHONPATH=/app` (Celery `No module named 'routers'`,
  2004x/24 h on the live worker), migration 023 (timestamp defaults; all live
  `scan_runs.created_at` were NULL), `/scan-runs` sorts NULLs last, dashboard reads
  `created_at` (was `finished_at`/`started_at`, so "Last scan" showed "-").
  Passed: ruff, backend pytest (757 passed, snmp_driver deselected), typecheck,
  216 frontend tests; demo stack on :3200 with migration 023 on PostgreSQL.
  User to verify: README screenshots on GitHub; rebuild live stack
  (`docker compose up --build -d`), then celery log free of `No module named
  'routers'` and dashboard "Last scan" shows a time after the next scan.

- Network latency monitor (released v3.2.0, 935d5bd) · priority: P2 · area: full-stack
  Done: `latency-monitor` service (iputils ping every 10 s, Redis lock), migration
  022 (`devices.latency_monitored`, `latency_samples` minute rollups), API
  `/latency/summary` + `/latency/history`, bulk `PUT /settings`; dashboard card,
  inspector section with sparkline and monitor toggle, map layer "Latency",
  Settings > Scan section. Passed: ruff, 756 backend tests (snmp_driver ignored),
  typecheck, 216 frontend tests, build; cross-review findings fixed.
  Smoke (local stack): migration 022 applied on PostgreSQL, monitor runs, probe as
  appuser returns RTT/jitter and 100 % loss for unreachable IPs. Not run: browser
  check (old netmap stack holds :3000; new DB has no devices yet).
  User to verify: `docker compose up --build -d`, `docker compose logs
  latency-monitor`, dashboard card on :3000 fills within ~1 min, map layer
  "Latency", inspector toggle in mode "selected".

- Less SNMP load per scan (released v3.1.0, cab1a9c) · priority: P2 · area: backend
  Done: interface name cache (migration 021), configurable bulk size (Settings ->
  Scan, "Bulk Size"), interval fallbacks 60 s / 300 s, separate VLAN (1800 s) and
  STP (300 s) refresh intervals applied in MAC scans. Passed: ruff, 698 backend tests
  (snmp_driver deselected, Python 3.13 env issue), typecheck, 192 frontend tests.
  User to verify on the live stack: ports keep names/aliases after link/MAC scans;
  scan durations in the scan history drop; optionally try Bulk Size 50; VLAN/STP
  map layers and port VLANs stay intact between refreshes.

- Rebranding NetMap -> Net2Map (v3.0.0) · priority: P2 · area: full-stack
  Released as v3.0.0 (be184f9; repo renamed to mainzerp/net2map): all names, runtime identifiers, CI,
  docs; Redis key and localStorage migrations with tests. Passed: ruff, 686 backend
  tests (7 `test_snmp_driver` fail locally on Python 3.13 also without the change),
  typecheck, 192 frontend tests.
  User to verify: UI shows Net2Map at http://localhost:3000; run the upgrade guide
  in `docs/OPERATIONS.md` on the live stack (data, map background, theme kept).

- Historical review findings fixed · priority: P2 · area: full-stack
  Done: CredentialUpdate ip validated like create; CSV formula-injection escaping
  with import round-trip; logout 401 on garbage, 200 idempotent (path exempt from
  global auth); SNMP walk cap 10000 with WARNING on truncation; profiles built
  once per scan; ping-only devices refresh last_seen; scheduler dispatch claim in
  Redis; stale scan jobs pruned; frontend ETag LRU, Logs pagination (100/page),
  VITE_API_TOKEN removed, typed api helpers, new "Use an access token" login option.
  Passed: 691 backend tests (clean container), 190 frontend tests, build.
  Review: login/logout, Logs page paging, CSV export/import, single-token login.
- Ops fixes and repo cleanup · priority: P2 · area: ops
  Done: /docs, /redoc, /openapi.json via nginx (OPENAPI_ENABLED, own CSP); demo
  mounts seed_db.py; compose passes LOG_LEVEL/JWT_EXPIRY_HOURS/AUDIT_RETENTION_DAYS/
  REQUEST_LOG_ENABLED/UVICORN_*/OPENAPI_ENABLED; purge reads the DB setting;
  /health no longer depends on Celery (`?deep=1` does); rate limits in Redis;
  docker-compose.ghcr.yml. Removed bundle_debug.js, todo.md, fix_encoding.py;
  migrate script -> scripts/; versions 2.2.0 in package.json and main.py.
  Verified live: /docs Swagger 200, /health and ?deep=1 ok.
  Review: open :3000/docs and :3000/redoc in the browser (CSP), demo seeding.

- Persistent database fencing for the scan lock · priority: P2 · area: backend
  Done: fence token per acquisition (Lua INCR, floored at Redis time), migration
  020 `lease_fences` (applied on local stack), fence upsert as first statement of
  every guarded transaction, StaleLeaseError -> lease-loss path, metric
  `netmap_stale_lease_rejections_total`. Passed: 619 backend tests (clean
  container), stale-writer scenario on SQLite. Not run: real concurrent PostgreSQL.
  Review: run a normal scan on :3000, it must finish as before.
- Vendor detection prefix boundary · priority: P2 · area: backend
  Done: OID boundary + longest prefix in `scanners/detection.py`, 15 tests.
  Review: devices keep their vendor after the next scan.
- API reference and ops guide · priority: P2 · area: docs
  Done: `docs/API.md` (19 routers, auth, WS, schemas), `docs/OPERATIONS.md`
  (env vars, update, rollback, troubleshooting); doc map + README link.
  Review: read both docs.

- API versioning (/api/v1 + deprecated /api alias) · priority: P1 · area: backend
  Done: decorators without /api, routers mounted under /api/v1 (OpenAPI) and /api
  (hidden, Deprecation + Link headers), version-aware auth exemptions, metrics
  labels normalized, frontend via apiUrl()/versionedPath() in src/api.ts; README
  section. Passed: ruff, backend tests (25 new), frontend tests/build.
  Review: UI works on :3000; `curl -i localhost:3000/api/devices` shows Deprecation.
- SNMPv3 engine ID discovery and override · priority: P1 · area: backend
  Done: migration 018 (credential v3_engine_id, discovered_engine_id,
  engine_id_seen_at), snmpEngineID.0 read after each scan, change -> WARNING +
  AuditLog engine_id_changed, override as securityEngineId, CredentialsTab UI.
  Passed: ruff, all 507 backend tests in a clean container of the built image
  (Py3.12, CI env), frontend 159 tests; migration 018 applied on the local
  PostgreSQL stack. Verified against a
  loopback PySNMP v3 agent, not a real switch.
  Review: run a real scan, check Settings > Credentials shows the engine ID.
  Not covered: bulk/config import-export of v3_engine_id.

## Done

- Release v2.2.0 (includes v2.1.2) · priority: done · area: release · tag v2.2.0
  CI green, images ghcr.io/mainzerp/netmap/{backend,frontend}:v2.2.0, GitHub release.
- Logical topology overlays (STP + VLAN, one color per VLAN id) · priority: done · area: full-stack · v2.2.0
  Limits: Cisco PVST default instance only; intra-rack links get no overlay.
- Rack device labels beside the rack · priority: done · area: frontend · v2.2.0
- Cartography phase 4-5: racks (stylized port tiles) and motion · priority: done · area: frontend · v2.2.0
- Hide Auto-Layout when a floor-plan background is set · priority: done · area: frontend · v2.2.0
- Cartography phase 3: topology map · priority: done · area: frontend · v2.2.0
- Cartography polish leftovers · priority: done · area: frontend · v2.2.0
- Security gaps closed and CI builds gated · priority: done · area: security · v2.1.2 (a5cbaa4)
- Deep code review, security hardening and UI polish · priority: done · area: full-stack · v2.1.2 (a5cbaa4)
- Code review fixes (session 2026-09-28) · priority: done · area: full-stack · v2.1.1
- Rack link highlight on window resize · priority: done · area: frontend · v2.1.x
- Firmware version scanning · priority: done · area: full-stack · v2.1.x
- Responsive/mobile layout · priority: done · area: frontend · v2.0.0
- Dark/light theme toggle · priority: done · area: frontend · v2.0.0
- Cartography phase 2: Ctrl+K command palette and shared inspector drawer · priority: done · area: frontend · v2.2.0
- UI redesign prototype "Cartography" (Billio palette) · priority: done · area: frontend · v2.2.0 (03426f4)

- Endpoint table separation · priority: done · area: full-stack · v1.16.0
- TypeScript migration, component tests, lazy loading, toasts, keyboard shortcuts ·
  priority: done · area: frontend · v1.15.0
- RBAC, scan queue, historical scan runs, observability, backup tooling · priority:
  done · area: full-stack · v1.7.0-v1.14.0

## Idea Bank

- Active VLAN provisioning (MAC-based) -- auto-reconfigure switch ports when a known
  MAC is detected during the frequent port scan
- Endpoint group management -- group end devices and assign target VLANs
- 802.1X / MAB status per port (authorized, unauthorized, guest VLAN)
- Dynamic VLAN assignment visualization (RADIUS/NAC)
- Rogue device detection -- alert on unknown MACs on access ports
- Interactive port shutdown/bounce from the map UI (requires write credentials)
