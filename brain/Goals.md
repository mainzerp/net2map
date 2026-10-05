# Goals -- current stretch

User-selected 2026-09-15 (top priorities):

1. **UI polish** -- responsive/mobile layout and dark/light theme toggle are
   implemented (v2.0.0 frontend rework) and in user verification (see roadmap
   Testing column); logical topology overlays (STP root paths, blocked ports,
   VLAN views) remain open and now build on the React Flow map in
   `src/features/topology`.
   Outcome: usable on smaller screens, comfortable in light environments, deeper
   topology insight.
2. **API versioning + SNMPv3 engine ID discovery** -- add a version prefix to the API
   so it can evolve backward-compatibly; auto-discover SNMPv3 engine IDs for enterprise
   switches that require an explicit engine ID.
3. **Stability / quality / docs** -- keep test coverage growing, add an API reference
   and an ops/deployment guide, clean up loose ends (stray root scripts, stale
   `frontend/package.json` version).

Current focus (user request, 2026-10-01): close the remaining review security gaps,
migrate vulnerable SNMP/frontend dependencies and block GitHub image builds when
security scans fail. API versioning and SNMPv3 discovery remain next
priorities; responsive layout and theme switching need user verification rather
than initial implementation. Docs land alongside each change. NAC/VLAN-provisioning
ideas stay parked in the roadmap Idea Bank until promoted.
