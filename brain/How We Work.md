# How We Work

Build rhythm: small, verified changes committed straight to `main` (no PR flow). Never
commit unless the user asks. Cards move to `Testing` in `brain/roadmap.md` when code
work is done; only the user moves them to `Done`.

## Verification (run before declaring a task done)

- Backend lint: `ruff check backend/` (config in `backend/pyproject.toml`, line length
  120, py312, rules E/W/F/I).
- Backend tests: `cd backend && python -m pytest tests/ -v` (CI uses
  `DATABASE_URL=sqlite:///./test.db` and a dummy SECRET_TOKEN; pytest.ini enforces
  coverage with `--cov-fail-under=10`).
- Frontend: `cd frontend && npm run typecheck` and `npm test` (vitest, run mode).
- Full stack smoke: `docker compose up --build -d` -- UI at http://localhost:3000.

CI (`.github/workflows/ci.yml`) runs lint + backend tests + frontend tests on push/PR
to `main`; on `v*` tags it builds and pushes images to
`ghcr.io/mainzerp/netmap/{backend,frontend}`.

## Standards

Documentation standards and the doc map live in `docs/README.md`. The release process
and versioning rules live in `AGENTS.md` (Release & Git). Operating rules for agents
(delegation, language, tooling) live in `AGENTS.md` and are never duplicated here.
