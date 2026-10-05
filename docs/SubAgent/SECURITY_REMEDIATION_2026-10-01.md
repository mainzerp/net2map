# Security remediation and build gate -- 2026-10-01

Follow-up to `CODE_REVIEW_2026-10-01.md`; the earlier report remains a historical
snapshot. The user authorized the remaining dependency migrations and a mandatory
GitHub security check before builds. No commit, tag or deployment is included.

## Changes

- Backend: replace pysnmp-lextudio 5.0.34 and pyasn1 0.4.8 with maintained
  PySNMP 7.1.30, pyasn1 0.6.4 and modules 0.4.2. Adapt asynchronous target creation,
  command APIs, flat bindings and dispatcher cleanup. Preserve explicit V2c/V3
  credentials; stop walks on exception bindings, non-increasing OIDs and limits.
- Frontend: Router 7.18.4, Vite 8.3.2, Vitest 4.1.11 and React plugin 6.1.1;
  keep React 18.3.1. Node 24 is the CI/Docker builder, with Node 22.12 also supported
  locally. Lockfile install remains reproducible through `npm ci`.
- Workflow: mandatory `security-scan` runs pip-audit against resolved requirements,
  npm audit including development dependencies at every severity, and Bandit
  medium/high at every confidence. No dependency advisory ignores or optional scans.
  Rule-specific SNMP compatibility comments explain intentional explicit protocols.
- Both Docker jobs depend directly on successful security scanning and require
  `success()` plus `needs.security-scan.result == 'success'`. Failed, cancelled
  or skipped scans block builds and tag publication. Default token permission is
  `contents: read`; package writing is confined to the publication job.
- Actions are pinned to verified commit SHAs. Audit tools run in a separate Python
  environment; npm installs without lifecycle scripts for the audit. Bash pipefail
  preserves scanner failure through output piping; Bandit parse errors also fail.
- WebSockets retain the originating credential after ticket consumption and
  revalidate five seconds after the last successful validation during both idle
  and busy operation. Validation runs off-loop with a five-second timeout;
  global Redis connect/read timeouts are two seconds with automatic retries disabled.
  Invalid/revoked/expired credentials close with 1008; unavailable auth closes
  with 1011. Connection removal prevents subsequent progress broadcasts.
- Scan work owns its target tasks, heartbeat and finalization worker. Observed
  ownership loss stops work; commit and post-flush checkpoints reject lease loss/cancellation.
  External cancellation drains thread work before Session close or lock release.
  Configured Redis outages never activate process-local fallback locks.

## Evidence

- Frontend all-dependency audit: zero known vulnerabilities, exit 0, without
  exclusions. Actual Node 24.21.0: typecheck, 64 tests and production build passed.
- Headless Edge: protected routes, login, all lazy page routes, populated rack/map,
  browser history and mobile navigation passed with zero page exceptions. API
  fixtures were mocked; live network scans remain a separate operational check.
- Backend actual resolved requirements audit: zero known vulnerabilities, exit 0,
  without advisory ignores. Real local UDP tests exercise maintained-driver GET/BULK
  response decoding and protocol/key registration rather than only suite mocks.
- Workflow actionlint 1.7.12 passed. Thirty-two modeled build/publish outcomes
  cover successful, failed, cancelled and skipped security status across event/ref
  combinations. Every unsuccessful status blocks both image jobs.
- Failure probes: vulnerable `requests==2.19.1`, a Bandit `eval` finding, a vulnerable
  npm development dependency and an unavailable npm advisory endpoint each exit 1.
  Fixtures were isolated outside application manifests; no vulnerable fixture was
  added to this repository.
- Final combined backend: 448 tests passed with actual resolved requirements;
  Ruff passed. Regression coverage includes Redis blackhole/no retries, nonblocking
  timed WebSocket validation, repeated native task cancellation and closed-loop
  subscriber exit, alongside SNMP transport and lease-loss cases.
- Final Bandit: zero medium/high findings and zero scan errors. Actionlint and
  `docker compose config --quiet` passed.
- `docker compose build backend frontend` passed. A disposable backend image
  using Python 3.12/Redis 6.4 passed all 448 backend tests with `--network none`;
  local UDP fixtures still use loopback, with no access to the user's network.
  The production Python version and resolved dependencies are therefore exercised,
  not only the host interpreter. No services were restarted.

## Limits

- Audits use advisory databases at execution time; a clean result is not proof of
  absence of all possible vulnerabilities. Database/service failures block CI.
- Lease checkpoints and renewal are not an atomic transaction spanning Redis and
  SQL. Strict cross-store fencing would require a persistent database fencing
  design; checkpoints close the observed-loss and orphan-finalizer defects.
- Redis `appendfsync everysec` durability and signing-key rotation after revocation
  storage loss remain operational requirements documented in README.
- The workflow has been validated locally; its hosted GitHub run requires pushing
  the changes. No publication or modification of the running stack was performed.

## References

- [PySNMP maintained API](https://docs.lextudio.com/pysnmp/v7.1/docs/api-reference)
- [Vite migration](https://vite.dev/guide/migration)
- [Vitest 4 migration](https://v4.vitest.dev/guide/migration)
- [React Router changelog](https://reactrouter.com/start/start/changelog)
