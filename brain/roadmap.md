# Roadmap

Board format: headings are columns, `- title · priority: ... · area: ...` lines are
cards. Short indented lines under a card carry outcome, next step, or verification.

## Backlog


- Persistent database fencing across Redis lease changes · priority: P2 · area: backend
  Observed lease loss, missing-client split brain and orphan finalizers are fixed
  in the security follow-up. Commit/post-flush checks do not provide an atomic
  transaction spanning Redis and SQL; a persistent fencing design is separate work.
  Verify: pause a commit across lease expiry/reacquisition and prove stale writes
  are rejected by the database, including concurrent PostgreSQL workers.
- Reconcile remaining historical review findings · priority: P2 · area: full-stack
  Reports: docs/SubAgent/CODE_REVIEW_2026-09.md and CODE_REVIEW_2026-10-01.md.
  September fixes and the October review are done (v2.1.1/v2.1.2); do not repeat
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

(none)

## Done

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
