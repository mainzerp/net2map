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

- Rebranding NetMap -> Net2Map (v3.0.0) · priority: P2 · area: full-stack
  Done in be184f9 (not pushed): all names, runtime identifiers, CI,
  docs; Redis key and localStorage migrations with tests. Passed: ruff, 686 backend
  tests (7 `test_snmp_driver` fail locally on Python 3.13 also without the change),
  typecheck, 192 frontend tests.
  User to verify: UI shows Net2Map at http://localhost:3000; run the upgrade guide
  in `docs/OPERATIONS.md` on the live stack (data, map background, theme kept).
  Open: rename GitHub repo to `net2map` before tagging v3.0.0; then release.

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
