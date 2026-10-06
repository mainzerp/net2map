# Project Definition: Net2Map

## Overview

Net2Map is a web application for discovering, visualizing, and managing network switch topologies using SNMP. It automatically scans the local network, collects device and link information via LLDP, and presents the results as an interactive map, rack view, and log feed.

## Purpose

The tool is designed for network administrators who need a clear, up-to-date picture of their switch infrastructure without relying on manual documentation. It reduces the effort of tracking device positions, port connections, speeds, and vendor details by automating discovery and persisting results in a local database.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, SQLAlchemy, Pydantic, PySNMP, Celery |
| Database | PostgreSQL 16 (via SQLAlchemy ORM, connection pooling) |
| Cache / Broker | Redis (Celery broker, WebSocket tickets, session data) |
| Task Queue | Celery worker + Celery Beat (periodic scan scheduling) |
| Frontend | React 18, React Router v6, Vite, TypeScript (partial) |
| Monitoring | prometheus-client (6 metrics, /metrics endpoint) |
| Serving | Nginx (static assets + reverse proxy to backend) |
| Deployment | Docker, Docker Compose (6 services) |

## Architecture

- **`backend/`** -- FastAPI application exposing a REST API. Handles SNMP scanning, LLDP topology discovery, MAC address collection, DNS PTR lookups, and all CRUD operations for devices, racks, credentials, and settings. Uses SQLAlchemy with PostgreSQL and Alembic for schema migrations.
- **`frontend/`** -- Single-page React application built with Vite, with TypeScript for the API layer (api.ts). Served by an Nginx container that also proxies `/api` requests to the backend container.
- **`celery worker`** -- Background scan execution and dry-run jobs via Celery, using Redis as the message broker.
- **`celery-beat`** -- Periodic scan scheduling via the `scheduler_tick` Celery task.
- **`redis`** -- Celery task broker, WebSocket ticket store (30s TTL), and general caching.
- **`postgres`** -- Primary data store with connection pooling (pool_size=10, max_overflow=20).
- **`docker-compose.yml`** -- Defines 6 services (`net2map-backend`, `net2map-frontend`, `net2map-celery`, `celery-beat`, `redis`, `postgres`) on a shared bridge network. The frontend is reachable at `http://localhost:3000`.

## Key Features

- **SNMP Discovery** – Supports SNMPv2c and SNMPv3 credentials/profiles. Scans a user-defined list of IP addresses in parallel (configurable `max_workers`).
- **Vendor Detection** – Automatically identifies device vendors (Aruba CX, FS.com, Generic) and extracts model strings from SNMP OIDs.
- **LLDP Topology** – Builds a graph of switch-to-switch links including port identifiers and link speed labels.
- **Rack Management** – Devices can be assigned to named racks with room metadata. Rack and device positions are persisted and editable in the UI.
- **Switch Classes** – Logical roles (e.g., Top of Rack, Aggregation) can be assigned to devices for visual grouping.
- **Manual Metadata Override** – Vendor, model, and label fields can be manually corrected per device via the UI.
- **Scan Scheduling** – Background scheduler runs periodic discovery, link, and MAC scans based on configurable intervals stored as app settings.
- **Scan Metrics** – Each scan run records total duration, per-switch duration, success/failure status, and effective worker count.
- **DNS Settings** – Custom DNS resolver IPs for PTR lookups are configurable through the UI.
- **Import / Export** -- Bulk import/export of devices and a full global config export/import are supported via the API.
- **Logs** -- A rolling in-memory log buffer (up to 5,000 entries) is exposed via the API and displayed in the Logs page.
- **Authentication / RBAC** -- JWT-based auth with admin/operator/viewer roles, login page, user management.
- **Tagged VLAN Collection** -- Q-BRIDGE-MIB bitmask parsing for tagged VLAN memberships per port.
- **Dry-Run Scanning** -- Preview scan results before committing to database.
- **Credential Fallback Chains** -- Priority-ordered credentials per IP with automatic fallback.
- **Bulk Device Operations** -- Multi-select ignore/re-enable from device table.
- **Endpoint Search & Locate** -- Global IP/MAC search highlighting exact switch and port.
- **Prometheus Metrics** -- 6 metrics with MetricsMiddleware and authenticated /metrics endpoint.
- **WebSocket Scan Progress** -- Real-time scan status updates via ticket-authenticated WebSocket.
- **Audit Logging** -- Persistent audit trail for security-sensitive operations.

## Frontend Pages

| Page | Description |
|---|---|
| Login | Authentication page with JWT login form |
| Dashboard | Overview of discovered devices, scan status, and network statistics |
| Map | Interactive topology map with draggable device nodes, LLDP links, rack detail slide-in, and endpoint search |
| Network | Network-level views and VLAN information |
| Devices | Device listing with bulk operations, ignore/re-enable, and metadata editing |
| Logs | Live log feed from the backend |
| Settings | SNMP credentials/profiles, scan settings, DNS settings, rack and switch class management, user management |

## API

The FastAPI backend auto-generates OpenAPI docs at `http://localhost:8000/docs`. Key endpoint groups:

- `/api/devices` – List, update position, update metadata, bulk import/export
- `/api/scan` – Trigger a scan, retrieve scan runs and per-switch metrics
- `/api/scan-settings` – Get/set parallel worker count
- `/api/dns-settings` – Get/set DNS resolver list
- `/api/credentials` – Manage SNMPv2c/v3 credentials
- `/api/snmp-profiles` – Manage reusable SNMP profiles
- `/api/racks` – Manage racks and room assignments
- `/api/switch-classes` – Manage switch role classes
- `/api/topology` – Retrieve LLDP link graph
- `/api/logs` – Retrieve buffered log events
- `/api/config/export` and `/api/config/import` -- Full configuration backup/restore
- `/api/auth` -- Login, logout, token refresh, WebSocket ticket exchange
- `/api/users` -- User CRUD with role management (admin only)
- `/api/audit` -- Audit log retrieval
- `/api/scan/jobs` -- Background scan job management
- `/api/scan/dry-run` -- Dry-run scan preview
- `/api/stats` -- Network statistics
- `/api/switch-models` -- Switch model management
- `/api/health` -- Health check endpoint
- `/metrics` -- Prometheus metrics (authenticated)
- `/ws/scan-progress` -- WebSocket for real-time scan progress (ticket-authenticated)

## Data Persistence

Primary data is stored in PostgreSQL 16 with connection pooling (pool_size=10, max_overflow=20). Schema migrations are managed by Alembic. Redis is used as the Celery task broker, for WebSocket ticket storage (30s TTL), and as a general cache. Data volumes: `net2map_pgdata` (PostgreSQL) and `net2map_redisdata` (Redis).

## Development Setup

### Docker (recommended)
```bash
docker compose up --build -d
# UI: http://localhost:3000
```

### Local (without Docker)
```bash
# Backend
cd backend
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
# Requires: PostgreSQL and Redis running locally
# Set DATABASE_URL, REDIS_URL env vars
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Celery worker (separate terminal)
celery -A celery_app worker --loglevel=info

# Celery Beat (separate terminal, optional)
celery -A celery_app beat --loglevel=info

# Frontend
cd frontend
npm install
npm run dev
# Vite: http://localhost:5173
```

## Conventions

- No emojis in code, comments, commit messages, or UI text unless explicitly requested.
- Use English for all code, comments, and documentation.
- Semantic versioning (SemVer): track changes in `VERSION.md`.
- Backend logging uses structured JSON log lines via the `_log_event` helper.
- The frontend communicates with the backend exclusively through the REST API; no direct DB access from the frontend.
