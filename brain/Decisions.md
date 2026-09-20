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
