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
- Responsive/mobile layout · priority: P2 · area: frontend
  Fix fixed pixel widths and desktop-only layout in header nav and settings sidebar.
- Dark/light theme toggle · priority: P2 · area: frontend
  Second token set + context-based theme switching (currently hardcoded dark theme).
- API reference doc · priority: P2 · area: docs
  18 routers currently have no reference documentation.
- Ops/deployment guide · priority: P2 · area: docs
  Env vars beyond `.env.example`; update/rollback flow; backup pointer to BACKUP.md.
- Logical topology overlays · priority: P3 · area: frontend
  Toggle map views for STP root paths, blocked ports, VLAN topologies.
- Repo cleanup · priority: P3 · area: repo
  Remove dead `frontend/src/main.jsx`, stray root files (`bundle_debug.js`),
  stale `frontend/package.json` version, decide fate of one-shot scripts.

## In Progress

(none)

## Testing

(none)

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
