# Mission

**User-confirmed 2026-09-15.**

NetMap discovers and visualizes switch topologies via SNMP. It scans the network with
vendor-aware SNMP scanners (Aruba CX, FS.com, UniFi, OPNsense, generic), builds LLDP
topology and per-port views, renders a network map with backgrounds and rack views, and
tracks end devices (endpoints) by MAC identity. RBAC, audit logging, a scan queue, and
observability make it operable day to day.

## Audience and winning

Personal homelab/network tool for Patric. Winning looks like:

- the app reliably reflects the real state of the home network: scans succeed, the map
  is accurate, endpoints are tracked;
- it runs stably as a Docker stack and is easy to back up, update, and debug;
- the codebase stays healthy enough that features can be added without archaeology.

Not goals today: multi-tenant operation, public SaaS, or broad external adoption.
