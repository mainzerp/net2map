# NetMap -- Operations and Deployment Guide

Agent-facing guide for running, configuring, updating and troubleshooting the NetMap
Docker stack. Product overview and quickstart live in the root `README.md` (German);
backup/restore commands live in `BACKUP.md`; the API is described in `docs/API.md`.

Sources: `docker-compose.yml`, `docker-compose.demo.yml`, `docker-compose.local.yml`,
`docker-compose.ghcr.yml`, `.env.example`, `backend/config.py`, `backend/Dockerfile`, `backend/entrypoint.sh`,
`frontend/Dockerfile`, `frontend/nginx.conf`, `backend/celery_app.py`,
`.github/workflows/ci.yml`, `scripts/backup.sh`, `scripts/restore.sh`.

## Architecture

All services share the bridge network `netmap`. Only the frontend publishes a host
port.

| Service | Container | Image / build | Port | Role |
|---|---|---|---|---|
| `frontend` | `netmap-frontend` | `./frontend` (node:24 build, nginx:alpine runtime) | host `3000` -> `80` | Serves the SPA; proxies `/api/`, `/ws/` and the OpenAPI paths (`/docs`, `/redoc`, `/openapi.json`) to `backend:8000`. |
| `backend` | `netmap-backend` | `./backend` (python:3.12-slim) | `8000` (internal only) | FastAPI via uvicorn. Runs Alembic migrations at start. |
| `celery-worker` | `netmap-celery` | `./backend` | none | Runs scan jobs (`celery -A celery_app worker --concurrency=4`). |
| `celery-beat` | `netmap-celery-beat` | `./backend` | none | Schedules `tasks.scheduler_tick` every 5 s and `tasks.purge_old_audit_logs` every 6 h. Schedule file `/data/celerybeat-schedule`. |
| `postgres` | `netmap-postgres` | `postgres:16-alpine` | `5432` (internal only) | Database `netmap`, user `netmap`. |
| `redis` | `netmap-redis` | `redis:7-alpine` | `6379` (internal only) | Celery broker/result backend, shared state, token revocation, WebSocket tickets, scan-update pub/sub. AOF on (`appendfsync everysec`). |

Volumes:

| Volume | Mounted at | Content |
|---|---|---|
| `netmap-pgdata` | postgres `/var/lib/postgresql/data` | Database. Covered by `BACKUP.md`. |
| `netmap-redisdata` | redis `/data` | Redis AOF (revocation entries, job state). |
| `netmap-data` | backend and celery-worker `/data` | Map background image (`/data/map-background.<ext>`). Not covered by the database backup. Map opacity/scale/color are stored in the database. |

Other compose details:

- Startup order: backend waits for postgres and redis to be healthy; frontend waits
  for backend to be healthy.
- Resource limits: postgres/backend/celery-worker 1 GB / 1 CPU, redis 256 MB,
  celery-beat 256 MB / 0.25 CPU, frontend 256 MB.
- Logging: `json-file` driver, `max-size 10m`, `max-file 3` for every service.
- nginx proxies `/api/` (body limit 25 MB, timeouts 300 s), `/ws/` (upgrade, read
  timeout 24 h) and `/docs`, `/redoc`, `/openapi.json` (OpenAPI UI, see below).
  `/health` and `/metrics` are not exposed through port 3000. Everything else falls
  back to the SPA `index.html`.
- OpenAPI UI: `http://localhost:3000/docs` (Swagger UI) and `/redoc`, enabled by
  default (`OPENAPI_ENABLED=true`). The pages and schema are public and static; API
  calls made from them still need a bearer token. The backend sends a docs-only CSP
  (jsDelivr CDN assets plus the hash of the inline bootstrap script); nginx omits its
  strict SPA CSP on those three paths. Set `OPENAPI_ENABLED=false` to return 404.
- Without Redis (bare-metal dev only), the backend falls back to an in-process
  scheduler thread and in-memory state; then it must run with one worker.

## Environment variable reference

Compose reads variables from the root `.env` (template: `.env.example`) and passes a
fixed subset into the containers. The backend reads its settings through
`backend/config.py` (pydantic-settings, case-insensitive env names, fallback file
`.env` in the backend working directory; the Docker image excludes `.env` via
`.dockerignore`).

Legend: Required = compose refuses to start without it (`${VAR:?...}`). Secret =
treat as a credential.

### Backend application settings (`backend/config.py`)

| Variable | Default in code | Set by compose | Required | Secret | Purpose |
|---|---|---|---|---|---|
| `DATABASE_URL` | `postgresql://netmap:netmap_pw@postgres/netmap` | yes, built from `POSTGRES_PASSWORD` | via `POSTGRES_PASSWORD` | yes (contains password) | SQLAlchemy and Alembic connection string. |
| `REDIS_URL` | empty | yes, `redis://redis:6379/0` (hard-coded) | no | no | Enables Redis state, Celery, revocation, WS tickets. Empty = single-process mode. Celery falls back to `redis://localhost:6379/0` when empty. |
| `CORS_ORIGIN` | `http://localhost:3000` | yes, `${CORS_ORIGIN:-http://localhost:3000}` (backend only) | no | no | Single allowed CORS origin. `*` logs a warning. Set to the public URL behind TLS. |
| `JWT_SECRET` | empty | yes, `${JWT_SECRET:-}` | no (recommended) | yes | HS256 signing key; enables JWT mode and RBAC. When set, `SECRET_TOKEN` is ignored. |
| `SECRET_TOKEN` | empty | yes | yes (compose) | yes | Legacy static bearer token (maps to role `admin`) and JWT signing fallback, only effective when `JWT_SECRET` is empty. |
| `JWT_EXPIRY_HOURS` | `24` | yes, `${JWT_EXPIRY_HOURS:-24}` (backend) | no | no | Token lifetime. Refresh grace is a fixed 1 h. |
| `ENCRYPTION_KEY` | empty | yes, `${ENCRYPTION_KEY:-}` | no (strongly recommended) | yes | Fernet key encrypting SNMP secrets at rest. Empty = plaintext (critical log at startup). Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Do not change it on an existing database without re-entering credentials. |
| `DEFAULT_ADMIN_PASSWORD` | `changeme` | yes (backend only) | yes (compose) | yes | Password of the `admin` user created by Alembic migration 006. Read only during that first migration (`os.environ` in `alembic/versions/006_add_users_table.py`); later changes have no effect. |
| `LOG_LEVEL` | `INFO` | yes, `${LOG_LEVEL:-INFO}` (backend) | no | no | Python logging level of the backend. |
| `AUDIT_RETENTION_DAYS` | `90` | yes, `${AUDIT_RETENTION_DAYS:-90}` (backend, celery-worker) | no | no | Fallback retention for the 6-hourly audit purge (runs in celery-worker) and the default of `DELETE /api/v1/audit-logs/purge`. The app setting `audit_retention_days` (DB, `PUT /api/v1/settings/audit_retention_days`) wins when it is a positive integer; invalid DB values are logged and ignored. `<= 0` here (without a DB value) disables the scheduled purge. |
| `REQUEST_LOG_ENABLED` | `false` | yes, `${REQUEST_LOG_ENABLED:-false}` (backend) | no | no | Logs one line per HTTP request (method, path, status, duration). `/health`, `/metrics`, `/ws*` are skipped. |
| `OPENAPI_ENABLED` | `true` | yes, `${OPENAPI_ENABLED:-true}` (backend) | no | no | Serves `/docs`, `/redoc` and `/openapi.json` (also via nginx on port 3000). `false` removes the routes. |

All optional variables are listed (commented, with defaults) in `.env.example`;
setting them in `.env` is enough, compose forwards them with defaults identical to
the code defaults. With `REDIS_URL` set, slowapi rate-limit counters are stored in
Redis (shared across uvicorn workers; in-memory fallback while Redis is down);
without it they are per process.

### Container and build variables

| Variable | Default | Where | Required | Secret | Purpose |
|---|---|---|---|---|---|
| `POSTGRES_PASSWORD` | none | compose (postgres, backend, celery) | yes | yes | Postgres superuser password and part of `DATABASE_URL`. Only applied when the `netmap-pgdata` volume is first initialized. |
| `UVICORN_WORKERS` | `1` | `backend/Dockerfile` CMD; compose `${UVICORN_WORKERS:-1}` (backend) | no | no | uvicorn worker count. More than 1 only with Redis (compose provides it). |
| `UVICORN_FORWARDED_ALLOW_IPS` | `*` | `backend/Dockerfile` CMD; compose `${UVICORN_FORWARDED_ALLOW_IPS:-*}` (backend) | no | no | Trusted proxies for `X-Forwarded-For` (rate limiting). Restrict to the proxy CIDR, e.g. `172.16.0.0/12`. |
| `RUN_MIGRATIONS` | `true` | `backend/entrypoint.sh` | no | no | Compose sets `false` for celery-worker and celery-beat so only the backend runs Alembic. |
| `VITE_API_URL` | empty | frontend build arg | no | no | Baked into the bundle at build time. Empty = same-origin (nginx proxy). Set for a remote backend, then rebuild. |
| `NETMAP_VERSION` | none | `docker-compose.ghcr.yml` | yes, with that override | no | GHCR image tag (git tag, e.g. `v1.2.3`) for the prebuilt-image override. |

## First-time setup

1. Install Docker with Compose v2 and make sure the daemon (Docker Desktop on
   Windows/macOS) is running.
2. `cp .env.example .env` and fill in at least:
   - `POSTGRES_PASSWORD`, `SECRET_TOKEN`, `DEFAULT_ADMIN_PASSWORD` (required).
   - `JWT_SECRET` (`python -c "import secrets; print(secrets.token_hex(32))"`),
     otherwise the stack runs in legacy single-token mode.
   - `ENCRYPTION_KEY` (Fernet key, see above).
   - `CORS_ORIGIN` = the URL users open (e.g. `https://netmap.example.com`).
3. `docker compose up --build -d`
4. Watch startup: `docker compose logs -f backend`. Expect
   `[entrypoint] Running Alembic migrations...` followed by uvicorn startup.
   Migrations run automatically on every backend start (`alembic upgrade head`).
5. Open `http://localhost:3000` and log in as `admin` with
   `DEFAULT_ADMIN_PASSWORD`. Create personal users (Settings) and change the admin
   password.
6. Put a TLS-terminating reverse proxy in front of port 3000 for production (see
   README, section "TLS / HTTPS Setup"). Do not publish the backend port.
7. Schedule backups (`BACKUP.md`, cron section) and keep a separate copy of `.env`.

## Update procedure

1. Back up first: `./scripts/backup.sh` (see `BACKUP.md`). Also copy `.env` and,
   if used, the `netmap-data` volume (map background).
2. Note the current version (`VERSION.md` heading or git tag) for a possible
   rollback.
3. Get the new code: `git fetch --tags && git checkout vX.Y.Z` (or `git pull` on
   `main`).
4. Rebuild and restart: `docker compose up --build -d`. If stale assets appear:
   `docker compose build --no-cache && docker compose up -d`.
5. Migrations: the backend entrypoint runs `alembic upgrade head` before uvicorn
   starts. Check `docker compose logs backend` for migration errors; a failing
   migration stops the container (`set -e`).
6. Verify:
   - `docker compose ps`: all services `running`, backend and celery-worker
     `healthy`.
   - `docker compose exec backend python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health').read().decode())"`
     -> `{"status": "ok", "checks": {"database": "ok", "redis": "ok"}}`; append
     `?deep=1` to include the Celery worker check (`"workers": "ok"`).
   - UI login at `http://localhost:3000` and a test scan.

### Prebuilt images

CI (`.github/workflows/ci.yml`, job `docker-push`) builds and pushes
`ghcr.io/mainzerp/netmap/backend:<tag>` and `ghcr.io/mainzerp/netmap/frontend:<tag>`
only for `v*` git tags (no `latest` tag). The backend image is built from
`backend/Dockerfile` and serves `backend`, `celery-worker` and `celery-beat` (only
the command differs). `docker-compose.ghcr.yml` switches those four services from
`build:` to `ghcr.io/mainzerp/netmap/{backend,frontend}:${NETMAP_VERSION}`:

```bash
export NETMAP_VERSION=v1.2.3   # or set it in .env
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

Compose aborts with `set NETMAP_VERSION` when the variable is missing. Private
packages need `docker login ghcr.io` first. Use the same `-f` pair for every later
command (`ps`, `logs`, `down`), otherwise compose falls back to local builds.

## Rollback procedure

Be aware of the constraint first: migrations are applied automatically and the
practical model is forward-only. Every Alembic revision has a `downgrade()`, but
downgrades are not exercised by CI, some are lossy (e.g. 013 restores endpoint data
only best-effort), and the entrypoint never runs them. The supported rollback is
therefore "old code + database restored from the pre-update backup".

1. Stop the stack: `docker compose down` (keep volumes; never `-v` here).
2. Restore the previous code: `git checkout <previous tag>` (or an override pinning
   the previous `ghcr.io/...:<tag>` images).
3. Start only the database: `docker compose up -d postgres`.
4. Restore the pre-update dump: `./scripts/restore.sh backups/netmap_<timestamp>.sql.gz`
   (details in `BACKUP.md`). All data written after the backup is lost.
5. Start everything: `docker compose up --build -d` and verify `/health` as above.
   On start the old code runs `alembic upgrade head`, which is a no-op on the
   restored schema.

If the update did not include a migration (no new file in
`backend/alembic/versions/`), step 3-4 can be skipped: rolling back the images or
code is sufficient. An `alembic downgrade <rev>` inside the backend container is
possible in principle but is untested; prefer the restore path.

After restoring older Redis data or losing the Redis volume, rotate `JWT_SECRET` so
previously revoked tokens cannot become valid again (README, "Sicherheit").

## Backups

See `BACKUP.md` (scripts `scripts/backup.sh` / `scripts/restore.sh`, manual
commands, cron, retention). Points not covered there:

- The scripts target the container name `netmap-postgres`; they do not work for the
  demo stack (`netmap-demo-postgres`) without editing.
- The `netmap-data` volume (map background image) is not part of the database
  dump.

## Health checks and metrics

- `GET /health` (unversioned, no auth): liveness. Checks database and Redis only;
  `200` with `status: ok`, or `503` with `status: degraded` and the failing check
  (`error: ...`). A missing Celery worker does not affect it.
- `GET /health?deep=1`: readiness. Adds a Celery worker ping (2 s timeout), reported
  as `workers` / `checks.celery` (`ok`, `none`, `unreachable`, `not_configured`);
  `503` when no worker answers while Redis is configured. Use it for external
  monitoring of the scan pipeline.
- Compose healthchecks:
  - postgres: `pg_isready -U netmap` (5 s).
  - redis: `redis-cli ping` (5 s).
  - backend: `urlopen("http://localhost:8000/health")` (liveness, no Celery) every
    10 s, start period 15 s. A `503` (database or Redis failing) counts as
    unhealthy; the frontend only starts once the backend is healthy.
  - celery-worker: `celery inspect ping` every 30 s.
  - celery-beat and frontend: none.
- `GET /metrics` (unversioned): Prometheus format. Requires a bearer token when
  auth is enabled (not auth-exempt) and is not proxied by nginx, so a Prometheus
  scraper needs network access to `backend:8000` and an `Authorization` header.
  Metrics (`backend/shared/metrics.py`): `netmap_request_duration_seconds`,
  `netmap_requests_total` (labeled by route template; legacy `/api` folded into
  `/api/v1`), `netmap_scan_duration_seconds`, `netmap_scans_total`,
  `netmap_scans_active`, `netmap_devices_total`, `netmap_ports_total`,
  `netmap_endpoints_total` (at the time of writing; `backend/shared/metrics.py` is
  authoritative and new metrics are being added). With `UVICORN_WORKERS > 1` each scrape hits one worker
  (no multiprocess aggregation configured).

## Logs

- Container logs: `docker compose logs -f backend` (also `celery-worker`,
  `celery-beat`, `frontend`, `postgres`, `redis`). Rotated by Docker at 10 MB x 3
  files per container.
- Backend format: `LEVEL logger: message`. Level via `LOG_LEVEL`; per-request lines
  via `REQUEST_LOG_ENABLED=true` (both set in `.env`, forwarded by compose).
- Startup warnings to look for: `SECURITY: No authentication configured`,
  `SECURITY: ENCRYPTION_KEY is not set`, `CORS_ORIGIN is set to '*'`,
  `Both JWT_SECRET and SECRET_TOKEN are set -- ignoring legacy SECRET_TOKEN`.
- In-app: `GET /api/v1/logs` (admin/operator) returns the structured in-memory log
  buffer of the answering backend process; the audit trail is under
  `GET /api/v1/audit-logs` (admin).

## Demo stack

`docker-compose.demo.yml` runs a second, isolated stack (own containers, volumes and
network via project name) next to the main one:

```bash
docker compose -p netmap-demo -f docker-compose.yml -f docker-compose.demo.yml up -d
docker compose -p netmap-demo -f docker-compose.yml -f docker-compose.demo.yml exec backend python seed_db.py
docker compose -p netmap-demo -f docker-compose.yml -f docker-compose.demo.yml down -v
```

- UI on `http://localhost:3200`.
- It reuses the locally built images `switch-map-backend` and `switch-map-frontend`
  (the compose project name derived from the `switch-map` checkout folder), so build
  the main stack first. In a checkout with a different folder name, adjust the image
  names.
- It uses the same `.env` values as the main stack.
- Seeding is manual (`exec backend python seed_db.py` above). `seed_db.py` is
  excluded from the image by `backend/.dockerignore`, so it can never run in
  production; `docker-compose.demo.yml` bind-mounts `./backend/seed_db.py` read-only
  into the demo backend.

`docker-compose.local.yml` is a separate override that moves the main frontend to
host port `3100` when port 3000 is taken:
`docker compose -f docker-compose.yml -f docker-compose.local.yml up -d`.

## Local development without Docker

- Backend: `cd backend && uvicorn main:app --reload --host 0.0.0.0 --port 8000`.
  Needs a reachable database (`DATABASE_URL`); without Alembic, `create_tables()`
  creates the schema from ORM metadata but does not seed the admin user (that only
  happens in migration 006). OpenAPI UI: `http://localhost:8000/docs`.
- Frontend: `cd frontend && npm run dev` (Vite on `:5173`, proxies `/api` and `/ws`
  to `http://localhost:8000`, see `frontend/vite.config.js`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `connection refused` / `ERR_CONNECTION_REFUSED` on `http://localhost:3000` | Docker Desktop (daemon) is not running, or the stack is down. | Start Docker Desktop, then `docker compose up -d`; check `docker compose ps`. |
| Vite terminal shows `http proxy error ... ECONNREFUSED` for `/api/...` or `/ws/...` | Dev server proxies to `localhost:8000` but no backend is listening there. | Start the backend locally on port 8000 (or point `VITE_API_URL` at a running backend). |
| Login fails with "Invalid username or password" on a fresh install | Admin password is whatever `DEFAULT_ADMIN_PASSWORD` was when migration 006 first ran (fallback `changeme` if unset at that time). Changing `.env` later does not update it. | Use the original value. Otherwise reset the hash in the `users` table or recreate the database (`docker compose down -v`, destroys data). |
| Compose aborts with `Set POSTGRES_PASSWORD in .env` (or `SECRET_TOKEN`, `DEFAULT_ADMIN_PASSWORD`) | Required variable missing. | Fill `.env` from `.env.example`. |
| Postgres auth errors after changing `POSTGRES_PASSWORD` | The password is only applied when the volume is initialized. | Revert the value, or change the role password inside postgres (`ALTER USER netmap PASSWORD ...`). |
| Frontend container never starts; backend `unhealthy` | `/health` returns 503 (database or Redis check failing). | `docker compose logs backend`; query `/health` inside the backend container to see which check fails. |
| Scans stay queued | No Celery worker answering. | `/health?deep=1` shows `"workers": "none"`; check `docker compose logs celery-worker`. |
| API returns `503 AUTH_UNAVAILABLE` | `REDIS_URL` configured but Redis unreachable; token revocation checks fail closed. | Check the `redis` container and its healthcheck. |
| Scan progress does not update live | WebSocket ticket needs Redis; nginx must pass `/ws/`. | Check Redis; check browser console for WS close codes `1008` (auth) / `1011` (auth service down). |
| SNMP secrets unreadable after restore or key change | `ENCRYPTION_KEY` differs from the key used to encrypt. | Restore the original key from the `.env` backup, or re-enter credentials. |

## Known discrepancies

Found while writing this guide; not fixed here (code and other docs are owned
elsewhere).

- `README.md` (Production Deployment) says to set `JWT_SECRET` or `SECRET_TOKEN`;
  compose actually requires `SECRET_TOKEN` in every case.
