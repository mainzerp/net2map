# Goals -- current stretch

User-selected 2026-09-15 (top priorities):

1. **UI polish** -- responsive/mobile layout (fix fixed pixel widths in header nav and
   settings sidebar), dark/light theme toggle (second token set, context-based
   switching), logical topology overlays (STP root paths, blocked ports, VLAN views).
   Outcome: usable on smaller screens, comfortable in light environments, deeper
   topology insight.
2. **API versioning + SNMPv3 engine ID discovery** -- add a version prefix to the API
   so it can evolve backward-compatibly; auto-discover SNMPv3 engine IDs for enterprise
   switches that require an explicit engine ID.
3. **Stability / quality / docs** -- keep test coverage growing, add an API reference
   and an ops/deployment guide, clean up loose ends (dead `frontend/src/main.jsx`,
   stray root scripts, stale `frontend/package.json` version).

Order of attack: API versioning design first (contract work that unblocks the rest),
then responsive layout, then theme toggle; docs land alongside each change rather than
as a separate campaign. NAC/VLAN-provisioning ideas stay parked in the roadmap Idea
Bank until promoted.
