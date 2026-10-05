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
  On a host Python 3.13 the 7 `test_snmp_driver.py` cases fail (pysnmp needs
  `asyncore`); run the suite in a clean container of the built image instead:
  `docker run --rm --entrypoint sh -e DATABASE_URL=sqlite:///./test.db -e SECRET_TOKEN=test-token switch-map-backend -c "cd /app && python -m pytest tests/ -q -o addopts=''"`.
  Do not run tests inside the live `netmap-backend` container: its compose env
  (Redis, JWT) breaks test assumptions.
- Backend code changes must also rebuild the workers: compose services are
  `backend`, `celery-worker`, `celery-beat` (`docker compose up -d --build backend
  celery-worker celery-beat`); the worker otherwise keeps running old code.
- Frontend: `cd frontend && npm run typecheck` and `npm test` (vitest, run mode).
- Full stack smoke: `docker compose up --build -d` -- UI at http://localhost:3000.

CI (`.github/workflows/ci.yml`) runs security scans, lint, backend tests and frontend
typecheck/tests on push/PR to `main` and release tags. Image build/publication
requires successful security checks; the concrete policy and local commands live
in README's security checks section. Successful `v*` tags publish images to
`ghcr.io/mainzerp/netmap/{backend,frontend}`.

## Standards

Documentation standards and the doc map live in `docs/README.md`. The release process
and versioning rules live in `AGENTS.md` (Release & Git). Operating rules for agents
(delegation, language, tooling) live in `AGENTS.md` and are never duplicated here.
