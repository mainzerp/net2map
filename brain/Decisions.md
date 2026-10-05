# Decisions

## Setup decisions (2026-09-15)

- **Brain created; AGENTS.md adapted.** `brain/roadmap.md` is the live pipeline board;
  `todo.md` is frozen as a legacy checklist and points here. Reason: one pipeline
  owner, no double bookkeeping.
- **Doc map.** `docs/README.md` created as the doc map. `docs/SubAgent/` keeps AI-agent
  ANALYSIS/PLAN working notes (session artifacts, not maintained user docs).
  `README.md` and `BACKUP.md` stay German because they are user-facing; agent-facing
  docs (brain, docs/README.md) are English; code and comments are always English.
- **Verification commands** (must pass before a task is declared done):
  `ruff check backend/`, `cd backend && python -m pytest tests/ -v`,
  `cd frontend && npm run typecheck`, `cd frontend && npm test`.
- **Commits.** Conventional Commits codified going forward: types `feat`, `fix`,
  `chore`, `docs`, `refactor`, `test`, `release`; scopes `backend`, `frontend`, `ci`,
  `docs`, `release`. History was loose (mixed prefixes); new commits follow the
  convention. Direct commits to `main`, no PR flow -- unchanged.
- **Intake.** None; the user reports tasks directly. The external-reports section was
  removed from AGENTS.md. The `workflows/` n8n export folder currently contains no
  workflows; purpose unconfirmed -- left untouched.
- **Version carrier.** `VERSION.md` (`## vX.Y.Z -- Title` headings with Type label).
  Not mirrored in code; the `frontend/package.json` version (1.0.0) is stale and
  ignored. Git tags `v*` drive CI image pushes to `ghcr.io/mainzerp/netmap`.
- **jcodemunch repo id.** `mainzerp/netmap` (derived from the git remote; the local
  folder is `switch-map`).

## Firmware version source (2026-09-20)

- **ENTITY-MIB first, sysDescr fallback.** Firmware comes from
  `entPhysicalSoftwareRev.1` (appended to the existing system-scalar GET, so no extra
  round trip); if the device does not answer it, the vendor scanner's
  `extract_version(sys_descr)` parses it out of sysDescr. Reason: one OID works on
  most managed switches, but several vendors only carry the version in sysDescr —
  the fallback keeps coverage without per-vendor OID tables.

## Credential masking contract (2026-09-20)

- **Mask sentinels.** API responses mask `community`, `v3_auth_password` and
  `v3_priv_password` as `"***"`; config/bulk exports use `"********"`. Backend update
  paths treat both sentinels as "unchanged" and must never encrypt/store them; insert
  paths normalize masked values to `""`. Frontend edit forms map `"***"` to `""` and
  omit empty secret fields on submit. Reason: the old round-trip silently destroyed
  SNMPv3 passwords on any unrelated edit.
- **Viewer is read-only** for device/rack positions, bulk export and `/api/logs`
  (admin/operator required). `/api/auth/refresh` enforces token blacklist and user
  revocation; the legacy static token only works when no `JWT_SECRET` is configured.
- **Scan lock** uses a UUID owner token with compare-and-delete release and periodic
  renewal (TTL 600s was shorter than real scan durations); manual scans acquire the
  same lock as scheduled ones.
- **Vendor override is a real flag.** `devices.vendor_override` (migration 014) is set
  when a user edits `vendor` via the device-meta endpoint and cleared when the vendor
  is emptied; the scan executor only honors a DB vendor when the flag is set,
  otherwise auto-detection wins. Bulk import/export matches credentials on
  `(ip, priority)`, matching the unique constraint.

## Frontend rework (v2.0.0)

- **Tailwind v4 token-based styling** replaces inline styles: theme tokens in
  `src/index.css` (dark default, light via `[data-theme="light"]`), semantic
  utilities (`bg-surface`, `text-primary`, `border-line`). Reason: one theme
  source, free dark/light switching, no per-component hex drift.
- **@xyflow/react + dagre for the topology map** (`src/features/topology/`).
  Reason: the hand-rolled SVG map could not deliver auto-layout, minimap, zoom
  controls and group nodes without growing unmaintainable.
- **TanStack Query as the data layer** (`src/hooks/api/`, QueryClientProvider in
  `main.tsx`). Reason: polling, caching and invalidation were re-implemented per
  page; the store now only holds UI selection state.
- **True U-based rack model** (migration 015: `Rack.height_u`,
  `Device.rack_u_position`, `Device.u_height`, `PATCH /api/racks/{id}/layout`)
  over the list-based rack panel ordering. Reason: the elevation view needs real
  U positions (U1 bottom, overlap detection); list order cannot express that.

## Review hardening (2026-10-01)

- **Durable session revocation is required for security mutations.** Configured
  Redis outages fail JWT verification closed; unavailable revocation prevents
  account security changes from committing. No process-local fallback: it would
  lose revocations on restart and disagree across workers. README owns operations.
- **Session boundaries invalidate frontend state.** Logout clears credentials
  immediately; login/logout/401 clear query and ETag caches. Requests and refreshes
  from an earlier session cannot restore its state.
- **Proxy trust starts at the bundled nginx edge.** Discard incoming forwarded-IP
  chains by default so clients cannot choose their rate-limit identity. Deployments
  with another proxy must explicitly configure trusted peers.
- **Rack PATCH validates the resulting layout.** Omitted devices retain their
  positions, so overlap checks include them; shrinking cannot truncate occupancy.

## Security remediation and CI gate (2026-10-01)

- **Dependency migrations are authorized.** Replace the incompatible legacy
  SNMP driver and upgrade the frontend toolchain/router rather than excluding
  advisory IDs. Preserve scan behavior and routing with import, transport and UI
  regression checks.
- **Security failure blocks image builds and publication.** The workflow must
  require successful dependency and static scans before either Docker job. Scan
  errors also block; dependency policy includes development packages and every
  reported severity. README owns the concrete commands and operating contract.
- **Intentional SNMP compatibility is explicit.** NetMap continues supporting
  user-selected v2c and v3 without privacy. Only the corresponding Bandit
  compatibility branches may carry rule-specific rationale; no global rule or
  dependency-advisory suppression. Recommend SNMPv3 authPriv for deployments.
- **Redis failure cannot create a second local scan owner.** Local locks are
  reserved for intentionally Redis-free operation; configured outages fail closed.
  Scan tasks own and drain their network/finalization work, with lease checks at
  transaction boundaries. Redis/SQL atomic fencing remains a separate design.
- **Live sockets share a bounded revalidation deadline.** A watchdog covers idle
  connections while broadcasts reuse the same check deadline. Single-use tickets
  are not consumed twice. Redis I/O has finite timeouts so outages cannot leave
  authentication checks waiting indefinitely.

## UI redesign direction (2026-10-05)

- **Visual language follows Billio (warm paper, ink navy, terracotta accent).** The
  previous palette was stock Tailwind slate/cyan and read as a generic admin template.
  Light "paper" is the default theme; dark is a derived "ink night" variant.
- **Typography stays plain: system font stack, no web fonts.** Character comes from
  color, layout and the map, not a display face; also drops the Google Fonts dependency.
- **Prototype first.** A /styleguide page and the redesigned dashboard are reviewed
  before the shell, map, racks and motion are rebuilt.
