# Switch-Map - Open Items

## UI / Frontend

- [x] **Class badge on rack detail panel** -- Show the assigned class name and color indicator on each switch in the rack side panel
- [x] **Class color on topology map nodes** -- Color-code switch nodes on the topology map by their class (Top of Rack = cyan, Access = green, Aggregation = amber, Core = purple)
- [x] **Rack / class filter on topology map** -- Add filter controls to show or hide devices by class or rack
- [x] **Settings: device overview tab** -- Add a "Devices" tab in settings showing all discovered devices with inline rack and class assignment columns

## Backend / Data

- [x] **Rack grouping via rack_id FK** -- Use the managed `rack_id` foreign key instead of (or alongside) the `location` string for rack grouping in the topology view
- [x] **Profile ID on seeded credentials** -- Assign `profile_id` to the seeded credentials so they correctly reference the global SNMP profiles

## Next Roadmap (High Impact)

- [ ] **Role-based login for settings/actions** -- Add authentication plus roles (read-only / operator / admin) for sensitive actions like scan config, credentials, and metadata changes
- [x] **Scan queue + cancel support** -- Move scan execution to background jobs with status endpoint and cancel option to avoid blocked API requests during long scans
- [x] **Historical scan runs** -- Persist scan summaries and per-switch durations in DB to compare trends over time (slow switches, discovery drops, error spikes)
- [x] **Retry + timeout policy per profile** -- Add configurable retries/timeouts/concurrency limits on SNMP profile level for better control in mixed network environments

## Observability

- [x] **Structured JSON logging** -- Emit structured logs for scan start/end, per-device result, and DNS lookup outcomes with correlation/run ID
- [ ] **Prometheus metrics endpoint** -- Expose counters/histograms (scan_duration, switch_scan_duration, scan_errors_total, dns_lookup_duration)
- [ ] **OpenTelemetry tracing** -- Add spans for run scan -> switch scan -> SNMP steps -> DB writes to troubleshoot performance bottlenecks

## Security / API Hardening

- [ ] **Rate limiting for heavy endpoints** -- Protect `/api/scan`, map uploads, and settings writes against abuse and accidental overload
- [ ] **Input validation hardening** -- Tighten validation for all settings endpoints (scan, DNS, map) and normalize error responses
- [ ] **Credential secret protection** -- Encrypt SNMPv3 secrets at rest (key via env var) and redact sensitive fields in logs/responses

## Product Improvements

- [x] **Topology diff view between scans** -- Show newly discovered/removed devices and links after each run
- [x] **Bulk import/export for credentials/profiles** -- CSV/JSON import with validation and dry-run mode
- [x] **Per-port endpoint count + multi-host tooltip** -- Show number of learned MAC/IP per switch port and optional expanded list in detail view

## DevOps / Reliability

- [ ] **Health endpoints for compose/k8s** -- Add explicit liveness/readiness endpoints for backend and wire them into deployment probes
- [ ] **Environment-based configuration matrix** -- Centralize runtime config via env vars (worker defaults, DNS fallback behavior, logging level, feature flags)
- [ ] **CI pipeline for lint/test/build** -- Run backend + frontend checks automatically before merge/release

## Network Map & Access Control (Future)

- [ ] **Active VLAN Provisioning (MAC-based)** -- Automatically reconfigure switch ports to a specific VLAN when a known MAC address is detected during the frequent port scan
- [ ] **Endpoint Group Management** -- Group recognized end devices/clients and assign target VLANs to these groups for automated provisioning
- [ ] **802.1X / MAC Authentication Bypass (MAB) status** -- Show authentication state per port (authorized, unauthorized, guest VLAN)
- [ ] **Dynamic VLAN assignment visualization** -- Highlight ports where VLANs were dynamically assigned via RADIUS/NAC
- [ ] **Rogue device detection** -- Alert on unknown MAC addresses appearing on access ports that are not in the allowed endpoints list
- [ ] **Interactive port shutdown/bounce** -- Allow admins to administratively down or bounce a port directly from the map UI (requires write credentials)
- [ ] **Logical topology overlays** -- Toggle map views to show Spanning Tree (STP) root paths, blocked ports, or specific VLAN topologies
- [ ] **Endpoint search & locate** -- Global search bar to find a specific IP/MAC and highlight the exact switch and port it is connected to



switches können ja racks classes und models zugeordnet werden. das edit form im switches tab sollte widerspielgeln, wenn ein switch über die anderen seiten eine zuordnung bekommen hat. momenta zeigt das edit form auf der switches page nicht an, ob ein switch schon z.b. einen rack zugeordnet ist

geht noch nicht