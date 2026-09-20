# NetMap - Deep Code Review 2026-09 (consolidated)

Read-only review of backend (web/API layer, scan engine) and frontend, including
verification of the findings from the 2025-01 review (`CODE_REVIEW_ANALYSIS.md`).
All findings verified against current code with file:line evidence. No files were
changed.

## Status of 2025-01 findings (selected)

| Old ID | Status | Evidence |
|---|---|---|
| CB-1 bulk import encryption | fixed | bulk.py:185-206 encrypts v3 passwords |
| CB-2 audit sessions | partial | shared/audit.py accepts db= but no caller passes it |
| CB-3 scheduler sessions | fixed | scheduler.py:76-112, tasks.py:73-76 finally-closed |
| SEC-1 auth disabled silently | partial | shared/auth.py:108-110 anonymous admin fallback |
| SEC-2 plaintext secrets | partial | crypto.py:18-22 passthrough; community never encrypted |
| SEC-3 default passwords | partial | compose `:?` for core secrets; config.py:22 `changeme` fallback |
| SEC-4 rate limiting | partial | login limited 5/min, but proxy-blind + per-worker |
| SEC-5 WS token in query | partial | ticket flow added; raw-JWT fallback still in query string |
| SEC-6 metrics exposed | fixed | auth enforced app-wide |
| SEC-7 password complexity | partial | length>=8 only |
| SEC-8 bulk export secrets | fixed | masked with `********` |
| CQ-2 monolithic engine | partial | split into scan_engine/, executor.py ~835 lines remains |
| CQ-8 scanner registry | partial | auto-registration via `__init_subclass__`; vendor tables hardcoded |
| PC-1 topology N+1 | partial | list paths eager; single-endpoint paths still N+1 |
| PC-2 ETag hashing | partial | /api/topology versioned; /api/devices, /api/endpoints hash per request |
| PC-3 DNS cache unbounded | fixed | dns.py:23-30 cap 10000, evicts half |
| PC-5 WS broadcast all | still present | ws.py:23-41 no scoping |
| PC-6 sync ping | fixed (ping) | subprocess-based; DNS still blocking (N6) |
| CQ-3/CQ-5/CQ-6/CQ-7, PC-4, dead main.jsx | see frontend findings below |

## New findings

### CRITICAL

1. **Unauthenticated map-background upload/delete.** `shared/auth.py:27` puts
   `/api/map-background` in `_AUTH_EXEMPT_PATHS` (method-agnostic); `_require_auth`
   returns early without setting `request.state.user` (auth.py:106-107);
   `require_role` treats a missing user as "auth disabled" and returns (auth.py:170-172).
   Net effect: POST/DELETE on `/api/map-background` (map_bg.py:45-46, 87-88) work
   with no token even in fully configured deployments. Fix: method-aware exemption
   (GET only) + fail-closed `require_role` (401 when user missing).

### HIGH

2. **Deactivated/deleted users keep access until token expiry.** `_require_auth`
   trusts the JWT without DB lookup (shared/auth.py:126-152); `update_user`
   (password change/deactivate) and `delete_user` never call
   `blacklist_all_user_tokens` (routers/auth.py:137-165). Fix: revoke on those paths.
3. **`/api/auth/refresh` bypasses revocation.** routers/auth.py:86-99 decodes with
   `verify_exp: False`, checks only the 60-min window and user existence; no
   jti-blacklist / revoke-all check. A logged-out token can be refreshed into a
   fresh one. Fix: apply the same checks as `_require_auth`.
4. **IP validation missing on update path.** `CredentialUpdate.ip` has no validator
   (schemas.py:269-286) while Create does (schemas.py:260-266); update applies it
   unchecked (credentials.py:61-79). These strings feed ping/SNMP execution paths.
   Fix: shared `Annotated[str, AfterValidator(...)]` type for both models.
5. **Thread-based scan jobs bypass the scan lock.** scan_engine/jobs.py:24-95 never
   call `acquire_scan_lock` (only scheduler.py:65 and tasks.py:44 do). User-triggered
   scans can run concurrently with scheduled ones: parallel delete/reinsert of
   `TopologyLink` (executor.py:691-696) and Device upserts produce duplicate/partial
   links. Fix: route all execution through one lock-guarded entry point.
6. **Celery retry leaves job stuck "running".** tasks.py:62-77: `self.retry` raises
   `Retry` which the except-clause does not catch; the trailing status update
   (tasks.py:79-86) never runs. Fix: write failed status before retrying or catch
   `Retry` explicitly.
7. **Scan lock TTL (600 s) shorter than long scans; release deletes foreign lock.**
   state.py:266-298, 337-345. After expiry a second scan starts in parallel, and
   value-based release (scan_type) deletes the new lock. Fix: unique owner id,
   heartbeat renewal, compare-and-delete via Lua.
8. **Deprecated sync `POST /api/scan` blocks the web event loop.** routers/scan.py:29-35
   awaits the full scan in the request handler; sync DB calls stall all HTTP
   requests; no lock taken. Fix: return 410 or forward to job path.
9. **`Port.jsx` shadows `Port.tsx` at runtime.** Both files exist; Vite's default
   extension order prefers `.jsx`, so the bundled component is the untyped one while
   tsc checks the `.tsx` - edits to `Port.tsx` silently never ship (SwitchPanel.tsx:4
   imports "./Port"). Fix: delete `Port.jsx` and `main.jsx`, drop `allowJs`.
10. **JWT refresh silently broken (base64url).** api.ts:52 `atob()` cannot decode
    base64url payloads; `isTokenExpiringSoon` is always false, refresh never fires,
    users get hard-logged-out at expiry. Fix: convert base64url to base64 before atob.

### MEDIUM (backend)

11. Export endpoints lack role gates: GET /api/bulk-export/{kind} (bulk.py:117-119),
    GET /api/config/export (config.py:22-24) - viewer tokens dump inventory/settings.
12. v2c community strings stored plaintext even with ENCRYPTION_KEY
    (credentials.py:38-41, bulk.py:185-206, config.py:131-156).
13. Rate limiting proxy-blind and per-worker: uvicorn without `--proxy-headers`
    (Dockerfile:28) so 5/min login limit is one shared bucket for everyone behind
    nginx; slowapi storage in-memory per worker.
14. Unbounded Prometheus label cardinality: raw request path used as label
    (main.py:108-111); ID-bearing paths create a series per object.
15. Upload size check after full buffering (map_bg.py:54-57): direct-to-backend
    requests are fully read into memory before the limit applies.
16. Blocking DNS resolution on the shared background loop (dns.py:16,53-56,80;
    called per ARP peer executor.py:596, per LLDP neighbor executor.py:741).
17. `asyncio.Lock` used from two event loops (ws.py:15,41-66): uvicorn loop vs
    background loop - "Future attached to a different loop" under contention.
18. `profiles_data` (with decrypted v3 secrets) rebuilt per range IP
    (executor.py:97-120): a /16 discovery duplicates secrets into 65k entries.
19. SNMP walks silently truncated at 500 rows (snmp_scanner.py:272; call sites
    695-726, 836-846) - partial endpoint/neighbor data on larger switches, no log.
20. Celery-beat interval state per-worker global `_last_dispatch` (tasks.py:91,113-126):
    fresh workers dispatch immediately; intervals shrink; tasks stack on lock.
21. Ignored devices still scanned in full/discovery mode (executor.py:61-71 vs
    586-589): SNMP load and stale snapshots persist despite "ignore".
22. `SCAN_ACTIVE` gauge leaks on exception (executor.py:58 vs 826, no try/finally).
23. Scan progress broadcasts only after gather completes (executor.py:341-400):
    live progress UI gets all events in one burst. Emit from `_scan_target_async`.
24. WebSocket auth edge cases (ws.py:91-105): ticket GET+DELETE not atomic
    (use GETDEL), raw-JWT fallback ignores jti blacklist, legacy compare not
    constant-time.
25. SVG sanitizer gaps (map_bg.py:32-43): unquoted handlers, `javascript:` URLs,
    CSS `url()` survive; served same-origin. Use allowlist sanitization or CSP
    sandbox on response.
26. Login timing difference enables username enumeration (routers/auth.py:34-39).
27. CSV export lacks formula neutralization (`=+-@` prefixes, bulk.py:104-114).

### MEDIUM (frontend)

28. Terminal scan states other than `scan_complete` leave UI stuck; WS reconnects
    every 3 s forever (DashboardPage.tsx:48, useScanProgress.tsx:56-59).
29. Dry-run poll interval leaks on unmount (ScanSettingsTab.tsx:201-218 vs correct
    pollRef pattern at 254-277, 127-131).
30. Vite dev proxy missing for `/ws` (vite.config.js:8-14) - 404 loop in dev.
31. WS fallback sends long-lived JWT in query string; lands in proxy logs
    (useScanProgress.ts:23-39). Also `VITE_API_TOKEN` baked into builds (api.ts:15).
32. Token in localStorage (api.ts:19-22); httpOnly cookie would be stronger
    (mitigated by CSP, no dangerouslySetInnerHTML anywhere - verified).
33. Drag desync when pointer leaves SVG (TopologyMap.tsx:383 vs 290-334): UI shows
    moved devices, reload snaps back. Persist on window-level pointerup.
34. Map drag re-renders all ports per mousemove: Port/SwitchPanel not memoized
    (Port.tsx:28, SwitchPanel.tsx:139-160); localize drag transform.
35. Unbounded lists without virtualization (EndpointTable.tsx:411-414,
    LogsPage.tsx:139-161 up to 2000 rows per 5 s).
36. ETag cache: FIFO not LRU, keys include full query strings (filter churn evicts
    hot entries), double `structuredClone` (api.ts:134-151; LogsPage.tsx:16).
37. Failed fetches rendered as empty states (EndpointTable.tsx:33-35 catch ->
    setEndpoints([]); ScanSettingsTab.tsx:218,275 `catch (_) {}`; MapPage.tsx:118
    console.error only).

### LOW (selection)

38. Misc correctness: `logout` returns 200 for garbage tokens (auth.py:180-184);
    `set_scan_job` re-EXPIREs the whole jobs hash per update (state.py:107-110);
    job registry never pruned without Redis, `delete_scan_job` has no callers
    (state.py:165-177); ping-only devices never refresh `last_seen`
    (executor.py:514-521); `future.result()` without timeout (jobs.py:36); failed
    Celery `.delay` orphans queued job (scheduler.py:56-70); entrypoint.sh:2
    mojibake in comment.
39. Dead/duplicated code: `src/main.jsx`, `src/components/Port.jsx`,
    unused design system `src/styles/shared.ts` + `tokens.ts`, DashboardPage
    re-implements store loadTopology (DashboardPage.tsx:33-43 vs store.ts:12-20).
40. api.ts returns `Promise<any>` throughout (api.ts:128-161); tsconfig allowJs.

## Test gaps (scope-relevant)

Well covered: scanner regex/registry (33 tests), DNS cache, db_helpers, ping
parsing, lock dispatch basics, cascade deletes, auth/token revocation, websocket
handshake. Critical untested paths: `_execute_scan` end-to-end (upserts, cancel,
dry-run, concurrent scans), snmp_scanner.py walk pagination/parsing, Celery retry
path, thread job path, topology version cache/ETag, scheduler interval logic.

## Positive patterns to keep

- Startup critical warnings for missing auth/encryption; compose `:?` enforcement.
- Structured errors via `api_error` + global handlers; role gates and audit logging
  on nearly all mutating endpoints; slowapi limits on writes.
- Password masking in outputs/exports with mask-preserving re-import.
- WS single-use ticket design (30 s TTL) - right direction, finish it.
- Frontend: per-route ErrorBoundary, lazy loading, proactive refresh attempt, ETag
  conditional fetch + invalidate(), real CSP headers, zero @ts-ignore, keyboard
  shortcut handling, shared test utilities.

## Prioritized remediation plan

1. **Security quick wins (1 day):** finding 1 (map-bg bypass), 3 (refresh
   revocation), 2 (revoke on user changes), 4 (IP validator on update),
   11 (role gates on exports), 9 (delete Port.jsx/main.jsx + allowJs).
2. **Token/WS lifecycle (1-2 days):** findings 10 (base64url), 24 (GETDEL,
   constant-time), 28 (terminal states, bounded reconnect), 29-30 (poll cleanup,
   /ws proxy).
3. **Scan pipeline correctness (2-3 days):** findings 5-8 (single lock-guarded
   entry point, owner-scoped heartbeated lock, retry status ordering, retire sync
   endpoint), 23 (progress inside _scan_target_async), 6 (tests for it).
4. **Engine hygiene (2 days):** 18 (profiles_data once), 19 (walk cap/logging),
   16 (DNS via to_thread), 17 (threading.Lock for WS clients), 20 (Redis
   last-dispatch), 21 (ignored filter in all modes), 22 (try/finally gauge).
5. **Hardening + perf (ongoing):** 12 (encrypt community), 13 (proxy-aware
   limiter), 14 (route-template metrics labels), 15 (chunked upload), 25 (SVG
   allowlist), 33-37 (memoized drag, virtualization, LRU cache, error states).
