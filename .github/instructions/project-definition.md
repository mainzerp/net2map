# Project Definition: NetMap

## Overview

NetMap is a web application for discovering, visualizing, and managing network switch topologies using SNMP. It automatically scans the local network, collects device and link information via LLDP, and presents the results as an interactive map, rack view, and log feed.

## Purpose

The tool is designed for network administrators who need a clear, up-to-date picture of their switch infrastructure without relying on manual documentation. It reduces the effort of tracking device positions, port connections, speeds, and vendor details by automating discovery and persisting results in a local database.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, SQLAlchemy, Pydantic, PySNMP |
| Database | SQLite (via SQLAlchemy ORM, WAL mode) |
| Frontend | React 18, React Router v6, Vite |
| Serving | Nginx (static assets + reverse proxy to backend) |
| Deployment | Docker, Docker Compose |

## Architecture

- **`backend/`** – FastAPI application exposing a REST API. Handles SNMP scanning, LLDP topology discovery, MAC address collection, DNS PTR lookups, and all CRUD operations for devices, racks, credentials, and settings. Persists all data in a SQLite file mounted as a Docker volume.
- **`frontend/`** – Single-page React application built with Vite. Served by an Nginx container that also proxies `/api` requests to the backend container.
- **`docker-compose.yml`** – Defines both services (`netmap-backend`, `netmap-frontend`) on a shared bridge network. The frontend is reachable at `http://localhost:3000`.

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
- **Import / Export** – Bulk import/export of devices and a full global config export/import are supported via the API.
- **Logs** – A rolling in-memory log buffer (up to 5,000 entries) is exposed via the API and displayed in the Logs page.

## Frontend Pages

| Page | Description |
|---|---|
| Dashboard | Overview of discovered devices and recent scan status |
| Map | Interactive topology map with draggable device nodes and LLDP links |
| Logs | Live log feed from the backend |
| Settings | SNMP credentials/profiles, scan settings, DNS settings, rack and switch class management |

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
- `/api/config/export` and `/api/config/import` – Full configuration backup/restore

## Data Persistence

All data is stored in a single SQLite database file (`netmap.db`) mounted via a named Docker volume (`netmap-data`). WAL journal mode is enabled for better read/write concurrency.

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
uvicorn main:app --reload --host 0.0.0.0 --port 8000

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
