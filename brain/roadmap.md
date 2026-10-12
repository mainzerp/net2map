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
