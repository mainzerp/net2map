# NetMap

NetMap ist eine Web-Anwendung zur Erkennung und Visualisierung von Switch-Topologien via SNMP.
Das Projekt besteht aus einem FastAPI-Backend (Scan, Persistenz, API) und einem React/Vite-Frontend (Map, Rack-Ansicht, Settings).

## Features

- SNMP-Scan für Geräte via SNMPv2c und SNMPv3
- Automatische Vendor-Erkennung (Aruba CX, FS.com, Generic)
- Topologie über LLDP-Links inkl. Port-/Speed-Infos
- Rack-Ansicht mit Geräte-Zuordnung und Sortierung
- Manuelle Metadaten-Anpassung pro Gerät (z. B. Vendor/Modell)

## Architektur

- `backend/` – FastAPI + SQLAlchemy + SNMP Scanner
- `frontend/` – React + Vite, ausgeliefert über Nginx im Docker-Setup
- `docker-compose.yml` – Startet Frontend und Backend gemeinsam

## Schnellstart mit Docker

Voraussetzung: Docker + Docker Compose

```bash
docker compose up --build -d
```

Danach ist die UI erreichbar unter:

- http://localhost:3000

Der Backend-Container speichert SQLite-Daten persistent im Docker-Volume `netmap-data`.

Stoppen:

```bash
docker compose down
```

Mit Löschen des DB-Volumes:

```bash
docker compose down -v
```

## Lokale Entwicklung (ohne Docker)

### Backend

```bash
cd backend
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux/macOS
# source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite läuft standardmäßig unter http://localhost:5173.

Optional kann die Backend-URL über `VITE_API_URL` gesetzt werden.

## Typischer Ablauf

1. In den Settings SNMP-Credentials/Profile anlegen
2. Scan starten
3. Geräte, Links und Racks in der Map prüfen
4. Bei Bedarf Vendor/Modell pro Gerät manuell korrigieren

## Scan-Settings und Metriken

- Die Anzahl paralleler SNMP-Abfragen ist in der UI unter `Settings -> Scan` konfigurierbar.
- Backend-API für Scan-Worker: `GET/PUT /api/scan-settings` mit `max_workers`.
- DNS-Resolver für PTR-Lookups sind in der UI unter `Settings -> DNS` konfigurierbar.
- Backend-API für DNS-Server: `GET/PUT /api/dns-settings` mit `servers` (IP-Liste).

Das Scan-Ergebnis (`POST /api/scan`) enthält zusätzliche Laufzeitdaten:

- `max_workers`: effektiv verwendete Worker-Anzahl
- `total_duration_ms`: Gesamtdauer für den Scanlauf
- `switch_metrics[]`: Dauer und Status pro Switch (`ip`, `label`, `duration_ms`, `success`, `error`)

## Tech Stack

- Backend: FastAPI, SQLAlchemy, Pydantic, PySNMP
- Frontend: React, React Router, Vite
- Deployment: Docker, Nginx

## Configuration

`VITE_API_URL` is baked into the frontend bundle at build time.
To point the frontend at a different backend URL, rebuild the image:
```bash
docker buildx build --build-arg VITE_API_URL=http://your-backend:8000 -t netmap-frontend .
```

## Security Notes

- **Authentication**: Set `SECRET_TOKEN` in the backend environment to enable bearer token authentication. Leave empty to disable (LAN-only setups).
- **No HTTPS**: All traffic is unencrypted HTTP. Do not use on untrusted networks. To enable HTTPS, place a reverse proxy (Traefik, Caddy, nginx) in front of the frontend container.
- **SNMP Credentials**: API responses mask SNMP v3 passwords. However, if you enable `SECRET_TOKEN`, ensure it is kept secret.