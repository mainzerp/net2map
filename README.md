# NetMap

NetMap ist eine Web-Anwendung zur Erkennung und Visualisierung von Switch-Topologien via SNMP.
Das Projekt besteht aus einem FastAPI-Backend (Scan, Persistenz, API) und einem React/Vite-Frontend (Map, Rack-Ansicht, Settings).

## Features

- SNMP-Scan für Geräte via SNMPv2c und SNMPv3
- Automatische Vendor-Erkennung (Aruba CX, FS.com, Generic)
- Firmware-Versionserfassung pro Gerät (ENTITY-MIB-OID mit Vendor-Parsing aus sysDescr als Fallback)
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

PostgreSQL speichert die Datenbank persistent im Docker-Volume `netmap-pgdata`.
Das Volume `netmap-data` enthaelt die unter `/data` abgelegten Dateien.

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

Voraussetzung: Node.js 24 (wie im Docker-Build und in CI); alternativ Node.js
22 ab Version 22.12. Das Frontend-Manifest legt diese unterstuetzten Versionen fest.

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

## Sicherheit

- **Authentifizierung:** `JWT_SECRET` aktiviert Benutzerkonten und Rollen. Der
  statische `SECRET_TOKEN` ist ein alternativer Modus ohne JWT. Ohne beide Werte
  sind die API-Endpunkte ohne Anmeldung erreichbar.
- **Sitzungswiderruf:** JWT-Sperren benoetigen Redis. Bei konfiguriertem, aber
  nicht erreichbarem Redis schlagen JWT-Pruefungen mit `503 AUTH_UNAVAILABLE`
  fehl. Ohne Redis bleiben Login und normale JWT-Zugriffe moeglich; Logout,
  Sitzungswiderruf sowie sicherheitsrelevante Benutzer-Aenderungen und Loeschungen
  melden `503`, statt einen erfolgreichen Widerruf vorzutaeuschen.
  Fehlgeschlagene Benutzer-Aenderungen werden nicht gespeichert. Die UI meldet
  lokal trotzdem ab und weist auf einen fehlgeschlagenen Server-Widerruf hin.
- **WebSockets:** Bestehende Scan-Verbindungen pruefen ihre urspruenglichen
  Zugangsdaten fuenf Sekunden nach der letzten erfolgreichen Pruefung erneut,
  auch ohne eingehende Nachrichten. Ablauf oder Widerruf schliesst die Verbindung mit Code `1008`;
  ein ausgefallener Auth-Dienst mit `1011`. Einmal-Tickets werden nur beim
  Verbindungsaufbau verbraucht, danach wird die zugehoerige Sitzung geprueft.
  Redis-Verbindungen haben je zwei Sekunden Verbindungs- und Antwortzeitlimit ohne
  automatische Wiederholung. Socket-Authentifizierung laeuft ausserhalb des
  Event-Loops mit insgesamt fuenf Sekunden Zeitlimit; die Pruefdauer kommt zum
  Intervall hinzu.
- **Redis-Persistenz:** Compose verwendet `netmap-redisdata` und AOF mit
  `appendfsync everysec`. Bei einem Absturz kann etwa eine Sekunde an Schreibvorgaengen
  verloren gehen. Nach Verlust oder Wiederherstellung veralteter Redis-Daten
  `JWT_SECRET` wechseln, damit zuvor gesperrte Tokens nicht erneut gueltig werden.
- **Proxy-Vertrauen:** Nginx ersetzt eingehendes `X-Forwarded-For` durch die
  direkte Gegenstelle. Hinter einem weiteren Reverse Proxy gilt daher dessen IP
  fuer das Rate-Limit. Echte Client-IPs nur mit explizit konfigurierten,
  vertrauenswuerdigen Proxy-Adressen uebernehmen; den Backend-Port nicht oeffentlich
  freigeben.
- **HTTPS:** TLS ueber einen Reverse Proxy vor dem Frontend bereitstellen;
  die mitgelieferten Container bieten selbst kein HTTPS.
- **SNMP-Zugangsdaten:** API-Antworten maskieren Communities und SNMPv3-Passwoerter.
  `ENCRYPTION_KEY` verschluesselt diese Werte in der Datenbank. Einen Schluessel
  erzeugt `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
- **SNMP-Protokoll:** Fuer neue Profile SNMPv3 mit Authentifizierung und
  Verschluesselung (`authPriv`, SHA-256/AES) verwenden. V2c und V3 ohne
  Verschluesselung bleiben fuer explizit konfigurierte Altgeraete verfuegbar;
  Community-Strings in V2c werden im Netzwerk unverschluesselt uebertragen.

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

### Sicherheitspruefungen und Build-Sperre

Der GitHub-Workflow `.github/workflows/ci.yml` prueft bei Pushes auf `main`,
bei `v*`-Tags und bei Pull Requests gegen `main`:

- `pip-audit`: alle aufgeloesten Backend-Abhaengigkeiten, ohne Advisory-Ausnahmen.
- `npm audit`: alle Schweregrade, einschliesslich Entwicklungsabhaengigkeiten.
- Bandit: Python-Produktionscode ab Schweregrad `medium`, alle Konfidenzstufen;
  Testdateien sind ausgenommen. Die bewusst unterstuetzten SNMP-Altprotokolle
  tragen ausschliesslich begruendete Ausnahmen fuer ihre jeweilige Regel.

Ein Fund oder ein Scan-Fehler laesst `security-scan` scheitern. Beide Docker-Jobs
(`docker-build` und `docker-push`) benoetigen dessen erfolgreichen Abschluss;
fehlgeschlagene, abgebrochene oder uebersprungene Scans verhindern Build und Push.
Image-Pushes bleiben auf `v*`-Tags beschraenkt. Die Job-Berechtigungen sind auf
Lesen reduziert; nur der Publish-Job erhaelt Schreibzugriff auf Packages.

Die gleichen Pruefungen lokal ausfuehren:

```bash
# Python backend
pip install pip-audit==2.10.1 bandit==1.9.4
pip-audit -r backend/requirements.txt --strict
bandit -r backend --exclude backend/tests --severity-level medium --confidence-level all

# Frontend
cd frontend
npm ci --include=dev
npm audit --include=dev --audit-level=info
```
