# Roadmap

Board format: headings are columns, `- title · priority: ... · area: ...` lines are
cards. Short indented lines under a card carry outcome, next step, or verification.

## Backlog

- Remediate 2026-09 deep code review · priority: P0 · area: full-stack
  Source: docs/SubAgent/CODE_REVIEW_2026-09.md (40 findings, evidence verified).
  Wave 1 (security quick wins): map-bg auth bypass, refresh revocation bypass,
  token revocation on user disable/delete, IP validator on update, export role
  gates, delete Port.jsx/main.jsx.
  Wave 2: scan lock owner-id + heartbeat, retry/status ordering, retire sync
  POST /api/scan, base64url token refresh fix, WS terminal states.
  Verify: ruff + backend pytest + frontend typecheck/tests; re-check findings
  by file:line from the report.
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
  Overlaps the "Remediate 2026-09 deep code review" backlog card.
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
