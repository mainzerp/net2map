# NetMap

NetMap ist eine Web-Anwendung zur Erkennung und Visualisierung von Switch-Topologien via SNMP.
Das Projekt besteht aus einem FastAPI-Backend (Scan, Persistenz, API) und einem React/Vite-Frontend (Map, Rack-Ansicht, Settings).

## Features

- SNMP-Scan für Geräte via SNMPv2c und SNMPv3
- Automatische Vendor-Erkennung (Aruba CX, FS.com, Generic)
- Interaktive Topologie-Karte (React Flow) über LLDP-Links inkl. Port-/Speed-Infos, Auto-Layout, Gerätesuche und Minimap
- Rack-Elevation unter `/racks`: echte U-Positionen (U1 unten), Drag-and-Drop mit Vorschau, einstellbare Gerätehöhe (`u_height`)
- Dashboard mit Status-Karten, Deep-Links und Live-Scan-Anzeige
- Dark-/Light-Theme (Tailwind-Design-System, Umschalter in der Sidebar)
- Manuelle Metadaten-Anpassung pro Gerät (z. B. Vendor/Modell)

## Architektur

- `backend/` – FastAPI + SQLAlchemy + SNMP Scanner
- `frontend/` – React + Vite + TypeScript (Tailwind v4, TanStack Query, React Flow), ausgeliefert über Nginx im Docker-Setup
- `docker-compose.yml` – Startet Frontend und Backend gemeinsam

## Schnellstart mit Docker

Voraussetzung: Docker + Docker Compose

```bash
docker compose up --build -d
```

> **Hinweis:** Verwende immer `--build`, damit Frontend-Abhaengigkeiten aus
> `package-lock.json` korrekt installiert werden und Aenderungen am Code in
> die Container uebernommen werden.
>
> Falls trotzdem alte Versionen auftauchen, erzwinge einen vollstaendigen
> Neuaufbau ohne Cache:
> ```bash
> docker compose build --no-cache && docker compose up -d
> ```

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
- Frontend: React, React Router, Vite, TypeScript, Tailwind CSS v4, TanStack Query, @xyflow/react
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
- **Encryption at Rest**: Set `ENCRYPTION_KEY` to encrypt SNMP passwords in the database. Generate a key with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.

## Production Deployment

Before deploying NetMap to production, ensure the following requirements are met:

1. **TLS/HTTPS**: NetMap does not include built-in TLS. You MUST place a TLS-terminating reverse proxy in front of the application. See the TLS / HTTPS Setup section below.
2. **Authentication**: Set `JWT_SECRET` (recommended) or `SECRET_TOKEN` to enable authentication. Without either, all endpoints are accessible without credentials.
3. **Encryption at Rest**: Set `ENCRYPTION_KEY` to encrypt SNMP passwords in the database. Without it, passwords are stored in plaintext.
4. **Strong Passwords**: Use strong, unique values for `POSTGRES_PASSWORD`, `DEFAULT_ADMIN_PASSWORD`, and all secrets. Never use the example values in production.
5. **CORS**: Set `CORS_ORIGIN` to your actual domain (e.g. `https://netmap.example.com`). Do not use `*` in production.

## TLS / HTTPS Setup

NetMap ships without TLS. To secure traffic in production, place a TLS-terminating reverse proxy in front of the frontend container. Common options:

### Option A: Caddy (automatic HTTPS)

```
# Caddyfile
netmap.example.com {
    reverse_proxy frontend:80
}
```

Run Caddy alongside docker-compose. It will obtain and renew Let's Encrypt certificates automatically.

### Option B: Traefik

Add Traefik labels to the `frontend` service in `docker-compose.yml`:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.netmap.rule=Host(`netmap.example.com`)"
  - "traefik.http.routers.netmap.tls.certresolver=letsencrypt"
```

### Option C: nginx with TLS

Create an `nginx-ssl.conf` with:

```nginx
server {
    listen 443 ssl;
    server_name netmap.example.com;

    ssl_certificate     /etc/ssl/certs/netmap.pem;
    ssl_certificate_key /etc/ssl/private/netmap.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://frontend:80;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

For any option, update `CORS_ORIGIN` in `.env` to match the HTTPS URL (e.g. `https://netmap.example.com`).

## Dependency Management

### Backend (Python)

Direct dependencies are listed in `backend/requirements.txt`. For production deployments, consider using `pip-tools` to lock transitive dependencies:

```bash
pip install pip-tools
pip-compile requirements.txt -o requirements.lock
```

### Frontend (Node.js)

`frontend/package-lock.json` is committed to the repository. It pins every
transitive dependency so that Docker builds (and CI) always install the exact
same versions via `npm ci`.

**Updating dependencies:**

```bash
cd frontend
npm install            # updates package-lock.json
npm audit fix          # optional -- apply security patches
```

Commit the updated `package-lock.json` together with any `package.json` changes.

### Vulnerability Scanning

Periodically audit dependencies for known vulnerabilities:

```bash
# Python backend
pip install pip-audit
pip-audit -r backend/requirements.txt

# Frontend
cd frontend && npm audit
```