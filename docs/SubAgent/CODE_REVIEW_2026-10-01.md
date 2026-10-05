# NetMap code and security review -- 2026-10-01

Scope: backend scan lifecycle, rack persistence, authentication/session revocation,
WebSocket authentication, deployment headers/persistence, frontend session state,
responsive shell/dialogs and dependency advisories. Static review, regression tests
and browser smoke complement each other; this is not a network penetration test.
Existing user changes in `backend/seed_db.py` and `docker-compose.demo.yml` were
preserved. No commit, tag or deployment was made.

## Confirmed findings addressed

| Severity | Finding and consequence | Correction / review target |
|---|---|---|
| High | Host-derived authorization path could treat a protected request as an exempt endpoint on directly reachable backend/unfiltered proxy. | `backend/shared/auth.py`: authorize server-parsed ASGI `scope["path"]`. |
| High | Redis errors bypassed JWT revocation checks; account changes could report successful revocation while old tokens remained usable. | `backend/shared/auth.py`, `backend/routers/auth.py`: fail closed when configured Redis is unavailable; require successful revocation before account mutation commit. |
| High | Logout/refresh races and retained query data could restore credentials or privileged cached state across sessions. | `frontend/src/api.ts`, `frontend/src/main.tsx`: synchronous logout, session-generation checks and cache reset. |
| High | Redis container recreation discarded session revocations. | `docker-compose.yml`: named Redis data volume and AOF; every-second fsync retains a crash-loss window. |
| Medium | WebSocket global HTTP auth dependency prevented real handshakes; ticket fallback allowed non-atomic consumption and tickets bypassed subsequent credential revocation. | `backend/shared/auth.py`, `backend/routers/ws.py`: connection-compatible guard, atomic consume and credential revalidation. |
| Medium | Client-provided forwarding chains could select the identity used by login rate limiting. | `frontend/nginx.conf`: replace forwarded chains with the immediate peer. Additional proxies need explicit trusted-peer configuration. |
| Medium | Location-level cache headers prevented inheritance of server-level security headers on SPA documents/assets. | `frontend/nginx.conf`: server-level cache header mapping preserves security headers. |
| High | A slow individual scan target could outlive the distributed lock TTL. | `backend/scan_engine/executor.py`: whole-run heartbeat independent of target completion. |
| Medium | Exhausted retries and enqueue failures left misleading active/queued jobs. | `backend/tasks.py`, `backend/scan_engine/scheduler.py`: terminal failure state while preserving Celery Retry signaling. |
| Medium | Full/discovery scans still contacted ignored devices; queued work continued after cancellation and dry-run status hid cancellation. | `backend/scan_engine/executor.py`: filter both credential and range targets, cancellation gates and preserved terminal status. |
| Medium | Partial rack layout updates allowed collision with omitted devices; rack shrink could truncate occupancy. | `backend/routers/racks.py`: validate the complete resulting layout and occupied height. |
| High | Pinned Starlette carried multiple published vulnerabilities, including URL reconstruction and range parsing issues. | `backend/requirements.txt`: FastAPI 0.138.1 and Starlette 1.7.0, verified in an isolated resolved Python 3.12 environment. Background images also reject excessive/multipart byte ranges. |

Dependency evidence: Python audit decreased from 11 distinct advisories across
Starlette/pyasn1 to 4 distinct pyasn1 advisories (raw audit entries include duplicates:
22 before, 8 after). See upstream
[Host/path advisory](https://github.com/Kludex/starlette/security/advisories/GHSA-86qp-5c8j-p5mr)
and [range handling advisory](https://github.com/Kludex/starlette/security/advisories/GHSA-7f5h-v6xp-fcq8).

## UI polish

- Responsive sidebar/footer, dynamic viewport sizing and usable mobile navigation.
- Login labels/autocomplete, accessible navigation names and stateful map filters.
- Map search empty state and narrow-screen toolbar wrapping.
- Dialog names, focus handling, bounded scrolling and larger close controls.
- Local logout remains immediate; unsuccessful server revocation is reported.

## Open risks and limits

- Frontend audit retains 6 package entries after compatible updates (14 before).
  The [critical Vitest advisory](https://github.com/advisories/GHSA-5xrq-8626-4rwp)
  concerns its UI server, not the normal test run or production browser bundle.
  [Vite Windows path handling](https://github.com/advisories/GHSA-fx2h-pf6j-xcff)
  and [esbuild disclosure](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
  concern development servers. Router 6.30.6 retains
  [redirect](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6) and
  [SSR hydration](https://github.com/advisories/GHSA-337j-9hxr-rhxg) advisories;
  this app uses client rendering and reviewed navigation targets are internal.
  These conditions reduce current exposure but do not resolve the advisories.
  npm proposes Vite 8.3.2, Vitest 4.1.11 and Router 7.18.4; major migrations need
  their own compatibility verification. Vite appears in production dependency
  classification through Tailwind, although it runs as build tooling.
- High: the legacy `pysnmp-lextudio==5.0.34` / `pyasn1-modules==0.2.8`
  dependency chain retains vulnerable `pyasn1==0.4.8`. A smoke import with
  pyasn1 0.6.4/modules 0.4.2 fails because the driver imports removed
  `pyasn1.compat.octets`. Fix requires a tested SNMP-driver migration, including
  real device scans; mocked API tests cannot establish compatibility. A malicious
  SNMP response can reach ASN.1 parsing. See the
  [upstream advisory](https://github.com/pyasn1/pyasn1/security/advisories/GHSA-jr27-m4p2-rc6r).
- Scan heartbeat does not fence writes after failed renewal/ownership loss.
  External coroutine cancellation can leave target tasks or an already-running
  `asyncio.to_thread` finalizer alive. Normal user cancellation regressions pass;
  process/Redis failure recovery needs a dedicated lifecycle design.
- Existing WebSocket connections are not periodically reauthenticated. Revocation
  is checked on new authentication/ticket consumption, not continuously.
- Redis AOF `everysec` can lose recent writes on crash. Lost/restored revocation
  data requires JWT signing-key rotation. No in-memory revocation fallback is used.
- Worker-local scheduling intervals and concurrent PostgreSQL rack updates need
  distributed/concurrency verification. Unit tests do not prove these behaviors.
- A real SNMP network scan and deployment against the user's persistent database
  remain user verification targets; no running stack was replaced for this review.

## Verification

- Frontend: `npm run typecheck`, `npm test` (64 passed), `npm run build` passed.
- Headless Edge with mocked API responses: mobile login and desktop/mobile rack
  empty states render without document overflow; drawer focus wraps and Escape
  restores the opener. Populated real-device views remain unverified.
- Isolated nginx container: `nginx -t` passed; `/index.html` returned CSP,
  X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
  and `Cache-Control: no-cache`.
- Actual legacy SNMP imports and an ASN.1 BER integer roundtrip passed with the
  retained decoder; upgrading that decoder alone failed its driver import smoke.
- Backend: isolated Python 3.12.10, FastAPI 0.138.1, Starlette 1.7.0;
  `uv run --python 3.12 --no-project --with-requirements requirements.txt python -m pytest tests/ -q`
  from `backend/`: 420 passed. Ruff passed. Tests mock SNMP; production network
  behavior is not implied. Warnings concern test JWT key lengths and deprecated
  TestClient/httpx integration.
- `docker compose config --quiet` passed. The existing deployed stack was not
  rebuilt or restarted.
