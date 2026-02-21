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
- [ ] **Scan queue + cancel support** -- Move scan execution to background jobs with status endpoint and cancel option to avoid blocked API requests during long scans
- [ ] **Historical scan runs** -- Persist scan summaries and per-switch durations in DB to compare trends over time (slow switches, discovery drops, error spikes)
- [ ] **Retry + timeout policy per profile** -- Add configurable retries/timeouts/concurrency limits on SNMP profile level for better control in mixed network environments

## Observability

- [ ] **Structured JSON logging** -- Emit structured logs for scan start/end, per-device result, and DNS lookup outcomes with correlation/run ID
- [ ] **Prometheus metrics endpoint** -- Expose counters/histograms (scan_duration, switch_scan_duration, scan_errors_total, dns_lookup_duration)
- [ ] **OpenTelemetry tracing** -- Add spans for run scan -> switch scan -> SNMP steps -> DB writes to troubleshoot performance bottlenecks

## Security / API Hardening

- [ ] **Rate limiting for heavy endpoints** -- Protect `/api/scan`, map uploads, and settings writes against abuse and accidental overload
- [ ] **Input validation hardening** -- Tighten validation for all settings endpoints (scan, DNS, map) and normalize error responses
- [ ] **Credential secret protection** -- Encrypt SNMPv3 secrets at rest (key via env var) and redact sensitive fields in logs/responses

## Product Improvements

- [ ] **Topology diff view between scans** -- Show newly discovered/removed devices and links after each run
- [ ] **Bulk import/export for credentials/profiles** -- CSV/JSON import with validation and dry-run mode
- [ ] **Per-port endpoint count + multi-host tooltip** -- Show number of learned MAC/IP per switch port and optional expanded list in detail view

## DevOps / Reliability

- [ ] **Health endpoints for compose/k8s** -- Add explicit liveness/readiness endpoints for backend and wire them into deployment probes
- [ ] **Environment-based configuration matrix** -- Centralize runtime config via env vars (worker defaults, DNS fallback behavior, logging level, feature flags)
- [ ] **CI pipeline for lint/test/build** -- Run backend + frontend checks automatically before merge/release
