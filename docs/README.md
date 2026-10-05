# NetMap -- Documentation Map

NetMap discovers and visualizes switch topologies via SNMP (FastAPI backend + React
frontend, deployed as a Docker stack). This file is the doc map: what each document
owns and the reading order. It does not own any topic itself.

## Reading order

1. `README.md` — product overview, architecture, quickstart (German).
2. `BACKUP.md` — database backup/restore manual.
3. `VERSION.md` — release history; single source of truth for the version.
4. `brain/BRAIN.md` — project brain: mission, goals, decisions, roadmap.
5. `docs/OPERATIONS.md` — when deploying, updating or troubleshooting the stack.
6. `docs/API.md` — when working on backend endpoints or API clients.

## What lives where

| Doc | Owns |
|---|---|
| `README.md` | Product overview, features, architecture, quickstart, local dev |
| `BACKUP.md` | Backup/restore manual for `scripts/backup.sh` / `restore.sh` |
| `VERSION.md` | Release history and version carrier (`## vX.Y.Z -- Title`) |
| `AGENTS.md` | Agent operating rules (delegation, language, release process) |
| `brain/BRAIN.md` | Front door to the brain: mission summary, reading order |
| `brain/Mission.md` | Why NetMap exists, what winning looks like |
| `brain/Goals.md` | Current stretch goals |
| `brain/How We Work.md` | Build rhythm and verification commands |
| `brain/Decisions.md` | Decisions with rationale |
| `brain/roadmap.md` | Live pipeline board (Backlog / In Progress / Testing / Done / Idea Bank) |
| `docs/API.md` | API reference: versioning, auth/RBAC, WebSocket ticket flow, error format, endpoint tables per router, central schemas (English) |
| `docs/OPERATIONS.md` | Ops/deployment: containers and ports, env var reference, setup, update/rollback, health/metrics, logs, demo stack, troubleshooting (English; backup commands stay in `BACKUP.md`) |

## Subfolder

- `docs/SubAgent/` — AI-agent working notes: `*_ANALYSIS.md` / `*_PLAN.md` pairs
  produced during past feature work (auto-refresh bug, code review, endpoint table,
  TS migration, ruff fixes, ...). They are session artifacts: read for background,
  do not treat them as current contracts, and do not update them retroactively.

## Rules

- Doc naming: `UPPERCASE.md` for root-level manuals, `docs/<topic>/` for grouped
  material. Doc map updates are part of docs closeout (see `AGENTS.md`).
- User-facing docs (`README.md`, `BACKUP.md`, `VERSION.md`) are German; agent-facing
  docs are English; code and comments are always English.
