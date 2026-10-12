# Net2Map -- Operations and Deployment Guide

Agent-facing guide for running, configuring, updating and troubleshooting the Net2Map
Docker stack. Product overview and quickstart live in the root `README.md` (German);
backup/restore commands live in `BACKUP.md`; the API is described in `docs/API.md`.

Sources: `docker-compose.yml`, `docker-compose.demo.yml`, `docker-compose.local.yml` (git-ignored),
`docker-compose.ghcr.yml`, `.env.example`, `backend/config.py`, `backend/Dockerfile`, `backend/entrypoint.sh`,
`frontend/Dockerfile`, `frontend/nginx.conf`, `backend/celery_app.py`,
`.github/workflows/ci.yml`, `scripts/backup.sh`, `scripts/restore.sh`.

## Architecture

All services share the bridge network `net2map`. Only the frontend publishes a host
port.

| Service | Container | Image / build | Port | Role |
|---|---|---|---|---|
| `frontend` | `net2map-frontend` | `./frontend` (node:24 build, nginx:alpine runtime) | host `3000` -> `80` | Serves the SPA; proxies `/api/`, `/ws/` and the OpenAPI paths (`/docs`, `/redoc`, `/openapi.json`) to `backend:8000`. |
| `backend` | `net2map-backend` | `./backend` (python:3.12-slim) | `8000` (internal only) | FastAPI via uvicorn. Runs Alembic migrations at start. |
| `celery-worker` | `net2map-celery` | `./backend` | none | Runs scan jobs (`celery -A celery_app worker --concurrency=4`). |
| `celery-beat` | `net2map-celery-beat` | `./backend` | none | Schedules `tasks.scheduler_tick` every 5 s and `tasks.purge_old_audit_logs` every 6 h. Schedule file `/data/celerybeat-schedule`. |
| `latency-monitor` | `net2map-latency-monitor` | `./backend` | none | `python -m latency.monitor`: pings monitored devices every `latency_interval_sec`, publishes state to Redis, writes per-minute rollups to `latency_samples`. Skips migrations, starts after the backend is healthy. |
| `postgres` | `net2map-postgres` | `postgres:16-alpine` | `5432` (internal only) | Database `net2map`, user `net2map`. |
| `redis` | `net2map-redis` | `redis:7-alpine` | `6379` (internal only) | Celery broker/result backend, shared state, token revocation, WebSocket tickets, scan-update pub/sub. AOF on (`appendfsync everysec`). |

Volumes (the compose file pins the project name `net2map`, so names do not depend on
the checkout folder):

| Volume | Mounted at | Content |
|---|---|---|
| `net2map_pgdata` | postgres `/var/lib/postgresql/data` | Database. Covered by `BACKUP.md`. |
| `net2map_redisdata` | redis `/data` | Redis AOF (revocation entries, job state). |
| `net2map_data` | backend and celery-worker `/data` | Map background image (`/data/map-background.<ext>`). Not covered by the database backup. Map opacity/scale/color are stored in the database. |

Other compose details:

- Startup order: backend waits for postgres and redis to be healthy; frontend waits
  for backend to be healthy.
- Resource limits: postgres/backend/celery-worker 1 GB / 1 CPU, redis 256 MB,
  celery-beat 256 MB / 0.25 CPU, latency-monitor 256 MB / 0.5 CPU, frontend 256 MB.
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
| `DATABASE_URL` | `postgresql://net2map:net2map_pw@postgres/net2map` | yes, built from `POSTGRES_PASSWORD` | via `POSTGRES_PASSWORD` | yes (contains password) | SQLAlchemy and Alembic connection string. |
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
| `POSTGRES_PASSWORD` | none | compose (postgres, backend, celery) | yes | yes | Postgres superuser password and part of `DATABASE_URL`. Only applied when the `net2map_pgdata` volume is first initialized. |
| `UVICORN_WORKERS` | `1` | `backend/Dockerfile` CMD; compose `${UVICORN_WORKERS:-1}` (backend) | no | no | uvicorn worker count. More than 1 only with Redis (compose provides it). |
| `UVICORN_FORWARDED_ALLOW_IPS` | `*` | `backend/Dockerfile` CMD; compose `${UVICORN_FORWARDED_ALLOW_IPS:-*}` (backend) | no | no | Trusted proxies for `X-Forwarded-For` (rate limiting). Restrict to the proxy CIDR, e.g. `172.16.0.0/12`. |
| `RUN_MIGRATIONS` | `true` | `backend/entrypoint.sh` | no | no | Compose sets `false` for celery-worker, celery-beat and latency-monitor so only the backend runs Alembic. |
| `VITE_API_URL` | empty | frontend build arg | no | no | Baked into the bundle at build time. Empty = same-origin (nginx proxy). Set for a remote backend, then rebuild. |
| `NET2MAP_VERSION` | none | `docker-compose.ghcr.yml` | yes, with that override | no | GHCR image tag (git tag, e.g. `v1.2.3`) for the prebuilt-image override. |

## First-time setup

1. Install Docker with Compose v2 and make sure the daemon (Docker Desktop on
   Windows/macOS) is running.
2. `cp .env.example .env` and fill in at least:
   - `POSTGRES_PASSWORD`, `SECRET_TOKEN`, `DEFAULT_ADMIN_PASSWORD` (required).
   - `JWT_SECRET` (`python -c "import secrets; print(secrets.token_hex(32))"`),
     otherwise the stack runs in legacy single-token mode.
   - `ENCRYPTION_KEY` (Fernet key, see above).
   - `CORS_ORIGIN` = the URL users open (e.g. `https://net2map.example.com`).
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
   if used, the `net2map_data` volume (map background).
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
`ghcr.io/mainzerp/net2map/backend:<tag>` and `ghcr.io/mainzerp/net2map/frontend:<tag>`
only for `v*` git tags (no `latest` tag). The backend image is built from
`backend/Dockerfile` and serves `backend`, `celery-worker`, `celery-beat` and
`latency-monitor` (only the command differs). `docker-compose.ghcr.yml` switches those
five services from
`build:` to `ghcr.io/mainzerp/net2map/{backend,frontend}:${NET2MAP_VERSION}`:

```bash
export NET2MAP_VERSION=v1.2.3   # or set it in .env
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

Compose aborts with `set NET2MAP_VERSION` when the variable is missing. Private
packages need `docker login ghcr.io` first. Use the same `-f` pair for every later
command (`ps`, `logs`, `down`), otherwise compose falls back to local builds.

### Upgrading from NetMap (v2.x) to Net2Map (v3.0.0)

v3.0.0 renames every runtime identifier from `netmap` to `net2map`: containers,
volumes, network, Postgres database and role, Redis key prefix, Prometheus metrics,
`NETMAP_VERSION` and the GHCR image path. Compose creates new, empty volumes, so the
data has to be carried over once. The old volumes stay untouched until you delete
them, which keeps a rollback to v2.x trivial.

1. Still on v2.x (old code, stack running), dump the database:
   `docker exec netmap-postgres pg_dump -U netmap -d netmap --no-owner --no-acl | gzip > backups/netmap_pre-net2map.sql.gz`
2. Stop the old stack, keep its volumes: `docker compose down` (with the same `-f`
   files you normally use).
3. Note the old volume names (prefixed with the old compose project, usually the
   checkout folder): `docker volume ls --filter name=netmap`.
4. Update to v3.0.0 (`git fetch --tags && git checkout v3.0.0`). In `.env`, rename
   `NETMAP_VERSION` to `NET2MAP_VERSION` if set.
5. Create the new containers and volumes without starting them:
   `docker compose up --build --no-start` (GHCR: `NET2MAP_VERSION=v3.0.0`, the
   `-f docker-compose.yml -f docker-compose.ghcr.yml` pair, `pull` first).
6. Copy the map background and the Redis data into the new volumes:
   ```bash
   docker run --rm -v <old>_netmap-data:/from -v net2map_data:/to alpine sh -c "cp -a /from/. /to/"
   docker run --rm -v <old>_netmap-redisdata:/from -v net2map_redisdata:/to alpine sh -c "cp -a /from/. /to/"
   ```
   The backend renames the legacy `netmap:*` Redis keys to `net2map:*` on start.
   Copying Redis keeps token revocations; if you skip it, rotate `JWT_SECRET`.
7. Start only Postgres (initializes database and role `net2map`), wait until
   `docker compose ps postgres` reports `healthy`, then restore:
   `docker compose up -d postgres` and
   `./scripts/restore.sh backups/netmap_pre-net2map.sql.gz`.
8. Start everything: `docker compose up -d`, then verify as in step 6 of the update
   procedure.
9. Follow-ups: update cron jobs (checkout path, backup files are now
   `backups/net2map_*.sql.gz`), Prometheus/Grafana queries (`netmap_*` metrics are now
   `net2map_*`) and pinned image references. Browser preferences (theme, map layers,
   rack order) migrate automatically on first load.
10. Once everything works, remove the old volumes:
    `docker volume rm <old>_netmap-pgdata <old>_netmap-redisdata <old>_netmap-data`.

Rollback before step 10: `docker compose down`, check out the previous v2.x tag and
start it again; it uses the untouched old volumes.

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
4. Restore the pre-update dump: `./scripts/restore.sh backups/net2map_<timestamp>.sql.gz`
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

- The scripts target the container name `net2map-postgres`; they do not work for the
  demo stack (`net2map-demo-postgres`) without editing.
- The `net2map_data` volume (map background image) is not part of the database
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
  - postgres: `pg_isready -U net2map` (5 s).
  - redis: `redis-cli ping` (5 s).
  - backend: `urlopen("http://localhost:8000/health")` (liveness, no Celery) every
    10 s, start period 15 s. A `503` (database or Redis failing) counts as
    unhealthy; the frontend only starts once the backend is healthy.
  - celery-worker: `celery inspect ping` every 30 s.
  - celery-beat, latency-monitor and frontend: none. Liveness of the latency
    monitor is its Redis heartbeat, exposed as `monitor_alive` in
    `GET /api/v1/latency/summary`.
- `GET /metrics` (unversioned): Prometheus format. Requires a bearer token when
  auth is enabled (not auth-exempt) and is not proxied by nginx, so a Prometheus
  scraper needs network access to `backend:8000` and an `Authorization` header.
  Metrics (`backend/shared/metrics.py`): `net2map_request_duration_seconds`,
  `net2map_requests_total` (labeled by route template; legacy `/api` folded into
  `/api/v1`), `net2map_scan_duration_seconds`, `net2map_scans_total`,
  `net2map_scans_active`, `net2map_devices_total`, `net2map_ports_total`,
  `net2map_endpoints_total` (at the time of writing; `backend/shared/metrics.py` is
  authoritative and new metrics are being added). With `UVICORN_WORKERS > 1` each scrape hits one worker
  (no multiprocess aggregation configured).

## Latency monitor

- Service `latency-monitor` (`backend/latency/monitor.py`). One round every
  `latency_interval_sec`: `ping -c <latency_pings> -i 0.2 -W 1 -q` per target, up
  to 32 in parallel, as `appuser` (same iputils-ping as the scan worker).
- Targets: enabled, not ignored devices (`latency_mode=all`), or only devices with
  `latency_monitored=true` (`selected`, set per device via
  `PATCH /api/v1/topology/devices/{id}/meta`). Hard cap 200 devices.
- Settings (`app_settings`, `PUT /api/v1/settings` or `/settings/{key}`, read every round, seeded
  on backend start): `latency_enabled` (`true`), `latency_interval_sec` (10, 5-300),
  `latency_pings` (3, 1-10), `latency_mode` (`all`), `latency_retention_days` (30,
  1-365).
- Redis keys: `net2map:latency:state` (hash, device id -> JSON state),
  `net2map:latency:heartbeat` (JSON, TTL `max(30, 3 x interval)` s),
  `net2map:latency:baseline` (hash, device id -> baseline ms); state and baseline
  carry the heartbeat TTL, refreshed every round, so they vanish after the monitor stops,
  `net2map:latency:monitor_lock` (single-instance lock, same TTL; a second instance
  logs `latency_monitor_lock_busy` and waits).
- Storage: table `latency_samples` (migration 022), one row per device and minute;
  rows older than `latency_retention_days` are purged hourly. Baselines are
  recomputed every 10 minutes from the last 24 h. Volume: about 1440 rows per
  device and day.
- Without Redis it still runs (warning `latency_monitor_no_redis`); the API then
  reads the newest rollups. Database or Redis errors are logged and the loop
  continues; unflushed minutes are retried for up to 15 minutes.
- Check: `docker compose logs latency-monitor` (events `latency_monitor_started`,
  `latency_monitor_*_failed`) and `monitor_alive` in `GET /api/v1/latency/summary`.

## Logs

- Container logs: `docker compose logs -f backend` (also `celery-worker`,
  `celery-beat`, `latency-monitor`, `frontend`, `postgres`, `redis`). Rotated by Docker at 10 MB x 3
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
docker compose -p net2map-demo -f docker-compose.yml -f docker-compose.demo.yml up -d
docker compose -p net2map-demo -f docker-compose.yml -f docker-compose.demo.yml exec backend python seed_db.py
docker compose -p net2map-demo -f docker-compose.yml -f docker-compose.demo.yml down -v
```

- UI on `http://localhost:3200`.
- It reuses the locally built images `net2map-backend` and `net2map-frontend`
  (named after the pinned compose project `net2map`), so build the main stack first.
- It uses the same `.env` values as the main stack.
- Seeding is manual (`exec backend python seed_db.py` above). `seed_db.py` is
  excluded from the image by `backend/.dockerignore`, so it can never run in
  production; `docker-compose.demo.yml` bind-mounts `./backend/seed_db.py` read-only
  into the demo backend and the demo latency monitor.
- The seed is deterministic and idempotent: each run wipes and recreates the demo
  tables. It fills every UI page:
  - 5 racks (placed on the map), 6 switch models, 30 devices (10 FS TOR, 15 Aruba CX,
    5 UniFi APs) with ports, firmware, interface names, VLANs and RSTP state, 30
    credentials, 2 SNMP profiles, 5 switch classes, 60 LLDP link entries.
    `aruba-rack-e-acc2` and `ap-rack-b-01` are offline (dashboard attention card).
  - About 230 endpoints with realistic OUIs on access and AP wireless ports, including
    moved endpoints (older port associations), inactive and ignored endpoints.
  - 21 scan runs over the last ~3 days with per-switch metrics (one run with SNMP
    timeouts during a rack D maintenance window, one dry run with a stored preview).
  - Latency history in `latency_samples` (24 h per minute, days 2-7 every 15 minutes);
    `ap-rack-c-01` is degraded and `aruba-rack-d-acc3` has packet loss in the last hour.
  - About 40 audit log entries, about 95 structured log lines in Redis
    (`net2map:logs`), and live latency state, heartbeat and baselines in Redis.
  - App settings: discovery ranges `192.168.1-5.0/24` and `192.168.10.0/24`, DNS
    servers `10.10.40.10` and `10.10.40.11`.
- Demo users (password `demo-password`): `operator` (operator), `viewer` (viewer),
  `noc-admin` (admin). The `admin` user from migration 006 is left untouched and keeps
  its `DEFAULT_ADMIN_PASSWORD`.
- Scheduled scans are disabled: `docker-compose.demo.yml` scales `celery-beat` to 0
  (otherwise a beat started before the seed dispatches scans against the fake IPs
  and marks every device offline), and the seed also sets `discovery_interval_sec`,
  `link_update_interval_sec` and `mac_update_interval_sec` to `0`. Do not start
  manual scans in the demo for the same reason.
- The demo `latency-monitor` runs `python seed_db.py --simulate-latency` instead of
  the ICMP monitor: the real monitor loop with a simulated probe. Every
  `latency_interval_sec` it publishes state to Redis and upserts the current-minute
  `latency_samples` rows. Before the first seed it simply finds no targets and keeps
  polling. Baselines refresh every 10 minutes; to see them right after seeding, run
  `docker restart net2map-demo-latency-monitor`.
- Screenshots in `docs/screenshots/` are taken from this stack (1600x1000 viewport,
  login `noc-admin`, map nodes at their seeded positions with "fit view"). Clear the
  browser cache after recreating the stack: a fresh Redis restarts `topo_version`,
  so a cached `/api/topology` ETag can match and serve stale data.

`docker-compose.local.yml` is a per-machine, git-ignored override (not in the
repository) that moves the main frontend to host port `3100` when port 3000 is taken:
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
| Postgres auth errors after changing `POSTGRES_PASSWORD` | The password is only applied when the volume is initialized. | Revert the value, or change the role password inside postgres (`ALTER USER net2map PASSWORD ...`). |
| Frontend container never starts; backend `unhealthy` | `/health` returns 503 (database or Redis check failing). | `docker compose logs backend`; query `/health` inside the backend container to see which check fails. |
| Latency card shows the monitor as offline (`monitor_alive=false`) | `latency-monitor` container stopped, crash-looping, or waiting for the lock. | `docker compose ps latency-monitor`; `docker compose logs latency-monitor`. |
| All latency targets `down` although devices answer scans | ICMP blocked between the monitor and the devices, or `ping` lacks `CAP_NET_RAW`. | `docker compose exec latency-monitor ping -c 3 <ip>`. |
| Scans stay queued | No Celery worker answering. | `/health?deep=1` shows `"workers": "none"`; check `docker compose logs celery-worker`. |
| API returns `503 AUTH_UNAVAILABLE` | `REDIS_URL` configured but Redis unreachable; token revocation checks fail closed. | Check the `redis` container and its healthcheck. |
| Scan progress does not update live | WebSocket ticket needs Redis; nginx must pass `/ws/`. | Check Redis; check browser console for WS close codes `1008` (auth) / `1011` (auth service down). |
| SNMP secrets unreadable after restore or key change | `ENCRYPTION_KEY` differs from the key used to encrypt. | Restore the original key from the `.env` backup, or re-enter credentials. |
| Celery log shows `No module named 'routers'` after `scan.end` (v3.2.0 and earlier) | Celery keeps `/app` on `sys.path` only while loading the app; lazy imports in tasks failed. | Fixed by `ENV PYTHONPATH=/app` in `backend/Dockerfile`; rebuild the images. |
