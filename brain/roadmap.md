# Roadmap

Board format: headings are columns, `- title · priority: ... · area: ...` lines are
cards. Short indented lines under a card carry outcome, next step, or verification.

## Backlog

- Cartography phase 3-5: map, racks, motion · priority: P2 · area: frontend
  Ink-stroke cables by speed, semantic zoom, scan sweep on the map; realistic rack
  faceplates with port LEDs; `motion` transitions honoring reduced-motion.
  Include: "Show on map" pans/zooms to the device node (today it only selects the rack).
- Cartography polish leftovers · priority: P3 · area: frontend
  22 ad-hoc rounded-lg panels -> rounded-card, bg-black overlays -> token scrim,
  vendor label contrast on map (<4.5:1), dark primary hover 3.95:1, ASCII vendor tags.
- Persistent database fencing across Redis lease changes · priority: P2 · area: backend
  Observed lease loss, missing-client split brain and orphan finalizers are fixed
  in the security follow-up. Commit/post-flush checks do not provide an atomic
  transaction spanning Redis and SQL; a persistent fencing design is separate work.
  Verify: pause a commit across lease expiry/reacquisition and prove stale writes
  are rejected by the database, including concurrent PostgreSQL workers.
- Reconcile remaining historical review findings · priority: P2 · area: full-stack
  Reports: docs/SubAgent/CODE_REVIEW_2026-09.md and CODE_REVIEW_2026-10-01.md.
  September fixes and the October review are tracked in Testing; do not repeat
  already-fixed auth/heartbeat/frontend work. Revalidate historical residuals
  before promoting new changes; verify each against current code and regression tests.
- API versioning strategy · priority: P1 · area: backend
  Outcome: versioned API surface that can evolve backward-compatibly.
  Verify: tests for versioned routes + VERSION.md entry.
- SNMPv3 engine ID auto-discovery · priority: P1 · area: backend
  For enterprise switches requiring an explicit engine ID.
  Verify: scanner test with a v3 profile; VERSION.md entry.
- API reference doc · priority: P2 · area: docs
  18 routers currently have no reference documentation.
- Ops/deployment guide · priority: P2 · area: docs
  Env vars beyond `.env.example`; update/rollback flow; backup pointer to BACKUP.md.
- Logical topology overlays · priority: P3 · area: frontend
  Toggle map views for STP root paths, blocked ports, VLAN topologies.
  Note: the map now runs on React Flow (@xyflow/react) -- overlays build on
  `src/features/topology` (TopologyCanvas, graph.ts, edges/).
- Repo cleanup · priority: P3 · area: repo
  Remove stray root files (`bundle_debug.js`), stale `frontend/package.json`
  version, decide fate of one-shot scripts. (Dead `frontend/src/main.jsx` and
  `Port.jsx` already removed in the v2.0.0 frontend rework.)

## In Progress

(none)

## Testing

- Close remaining security gaps and gate CI builds (2026-10-01) · priority: P1 · area: security
  SNMP/frontend migrations, live WebSocket revocation and scan cleanup are implemented.
  Passed: zero dependency advisories, Bandit medium/high+parse checks, 448 backend
  tests/Ruff, Node24 frontend typecheck/64 tests/build/browser and workflow gating.
  Both Docker images build; all 448 backend tests also pass inside Python3.12 image.
  Report: docs/SubAgent/SECURITY_REMEDIATION_2026-10-01.md; VERSION.md v2.1.2 unreleased.
  User verification: hosted GitHub security gate after push, real SNMPv2c/v3 scans,
  token revoke on live socket, populated map/rack and local Node24 development.
  No commit, push, publication or service restart performed.
- Deep code review, security hardening and UI polish (2026-10-01) · priority: P1 · area: full-stack
  Fixed auth/session/WS defects, proxy headers, Redis persistence, scan retry and
  cancellation defects, ignored scans, rack overlap/shrink and responsive/focus UI.
  Report: docs/SubAgent/CODE_REVIEW_2026-10-01.md; unreleased VERSION.md v2.1.2.
  Passed: isolated Python 3.12 actual requirements (420 tests), ruff, frontend
  typecheck/64 tests/build, mocked Edge responsive/focus smoke, nginx headers/config
  and Compose config. Dependency/runtime follow-up is tracked in the security
  remediation card; the original report is a historical snapshot.
  User review: login/logout, real SNMP scan/cancel, populated /map and /racks,
  mobile navigation and light/dark themes. No deployment or release performed.
- Code review fixes (session 2026-09-28) · priority: P1 · area: full-stack
  Backend: refresh-window revocation gap closed (TTL + REFRESH_GRACE_SECONDS,
  <= comparison), session revocation on role/deactivate/delete, WS legacy-token
  acceptance aligned with HTTP, scan lock renewed via as_completed + renew task
  during finalize, config export role gate, import resolves profile_label/
  device_ip, community strings encrypted at rest, DeviceBase validator replaced
  by field_validator (expired ORM safe), map-bg bounded read, schema bounds.
  Frontend: poll treats "queued" as active, DataTable pagination reset fixed,
  settings forms hydrate-once, map-bg two-impl sync, IPv6 last-colon split,
  drag-safe topology rebuild, useScanRuns limit key, rack clamp, vite ws proxy,
  CSP tightened, refresh-promise dedupe, CSS.escape, comparator NaN, cancel
  error toast, port-key fallback, reorder guard, bg version cache-bust.
  Historical residuals are tracked under "Reconcile remaining historical review findings".
  Verify: backend 390 tests + ruff green, frontend 56 tests + tsc clean; user
  should sanity-check login/logout, a real scan run and the /network table.
  User verification pending.
- Rack link highlight on window resize · priority: P3 · area: frontend
  RackDetail now recomputes the selected-link overlay line on window resize and
  panel box changes (resize listener + ResizeObserver in the link-line effect,
  src/components/map/RackDetail.tsx).
  Verify: select a rack-internal link on the map, resize the browser window —
  the highlight line must follow the ports. User verification pending.
- Firmware version scanning · priority: P2 · area: full-stack
  SNMP scan now collects firmware/software version per device: ENTITY-MIB
  entPhysicalSoftwareRev (.10) with entPhysicalFirmwareRev (.9) and
  vendor-specific sysDescr parsing (extract_version in backend/scanners) as
  fallbacks. New devices.firmware column (migration 016; 017 backfills NULLs
  and adds a server default), DeviceBase._coerce_nulls guards DeviceOut
  serialization against legacy NULLs. Shown in SwitchDetailSlideIn and as a
  dedicated sortable Firmware column in DeviceTable on the /network page
  (also searchable via the table search box).
  Verify: stack rebuilt locally (port 3100, migration 017 applied, /api/topology
  returns 200 with firmware populated for UniFi devices); run a real scan —
  firmware should appear in the device detail slide-in and the Firmware
  column on /network. User verification pending.
- Responsive/mobile layout · priority: P2 · area: frontend
  Implemented in the v2.0.0 frontend rework: collapsible sidebar, mobile drawer,
  fluid grids instead of fixed pixel widths.
  Verify: open the UI on a narrow viewport (or device emulation ~375px); sidebar
  collapses to a drawer, dashboard/map/settings remain usable without horizontal
  scrolling. User verification pending.
- Dark/light theme toggle · priority: P2 · area: frontend
  Implemented in the v2.0.0 frontend rework: token-based theme in
  `src/index.css` (dark default, `[data-theme="light"]`), toggle in the sidebar
  via `src/theme/ThemeProvider.tsx`.
  Verify: toggle the theme in the sidebar; all pages (map, racks, settings,
  dashboard) switch consistently and the choice survives a reload. User
  verification pending.

## Done

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
