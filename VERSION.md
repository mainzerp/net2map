# Version History

## v2.2.0 -- Neues Erscheinungsbild "Cartography"

**Type:** MINOR

Arbeitsstand, noch nicht veroeffentlicht; Prototyp fuer das UI-Redesign.

### Features

- Neue Farbpalette nach dem Vorbild von Billio: warmes Papier, Tinten-Navy und
  Terrakotta als einziger Akzent. Hell ist jetzt Standard; das dunkle Theme
  "Nachtkarte" ist daraus abgeleitet. Gespeicherte Theme-Wahl bleibt erhalten.
- Systemschrift statt Google Fonts; Icons ueber lucide-react; Sidebar in
  Tinten-Navy mit Terrakotta-Markierung des aktiven Eintrags.
- Dashboard neu aufgebaut: Statussatz als Ueberschrift, kompakte Scan-Leiste
  mit Abbrechen, Aufmerksamkeitsliste als Hauptbereich, kompakte Verteilungen.
- Neue Seite `/styleguide` zur Pruefung aller Farben und UI-Bausteine.
- Befehlspalette mit Strg/Cmd+K oder `/`: sucht Switches, Endpunkte (auch MAC
  ohne Trennzeichen), Racks und Ports, springt zu Seiten, startet Scans und
  wechselt das Theme. Zuletzt geoeffnete Ziele erscheinen bei leerer Suche.
- Gemeinsames Detail-Panel (Inspector) rechts fuer Switches, Endpunkte und
  Racks, per URL verlinkbar (`?inspect=device:<id>`), schliesst mit Zurueck oder
  Escape. Zeilen in den Geraete- und Endpunkt-Tabellen oeffnen es per Klick/Enter.

- Netzwerkkarte im Kartografie-Stil: Kabel als Tintenstriche, Strichstaerke nach
  Geschwindigkeit, ausgefallene Links gestrichelt, optionale Fluss-Animation
  ("Flow"), Papier-Raster als Hintergrund.
- Semantischer Zoom: weit entfernt nur Namen, nah zusaetzlich Port-Leiste und IP.
- Scan-Anzeige auf der Karte (Fortschrittslinie, dezente Ringe, kurz markierte
  Geraete). "Show on map" und die Kartensuche zoomen jetzt zum Geraet.
- Hersteller-Abzeichen statt ASCII-Kuerzeln ([AX], [FS], [UF]).
- Rack-Ansicht als technische Zeichnung: Schienen mit Lochraster und
  U-Nummern, Blindplatten, Geraetefronten mit Rack-Ohren und Status-LED.
  Ports als stilisierte Kacheln: gefuellt in Geschwindigkeitsfarbe wenn aktiv,
  hohl wenn inaktiv, Punkt fuer angeschlossene Endgeraete, Uplinks rechts
  abgesetzt; Legende unter dem Rack. Optionaler "Activity"-Schalter.
- Ruhige Animationen mit `motion` 13.4.4: Inspector, Befehlspalette, Dialoge,
  Toasts, Seitenwechsel, Dashboard-Aufbau und Mobil-Menue. Bei reduzierter
  Bewegung nur kurze Einblendungen.
- "Auto-Layout" erscheint nur noch, wenn kein Hintergrundbild (Grundriss) fuer
  die Karte hinterlegt ist, damit die manuelle Anordnung nicht verloren geht.

### Aenderungen

- Toasts, Fehleransicht und Einstellungen verwenden Theme-Farben statt fester
  Hex-Werte. Der Standard-Kartenhintergrund folgt dem Theme ("Follow theme").
- Die Switch-Detailansicht der Karte (SwitchDetailSlideIn) wurde durch den
  Inspector ersetzt.
- Einheitliche Rundungen und Overlay-Abdunklung; im dunklen Theme ist der
  Hover-Zustand des Hauptbuttons heller und kontrastreicher. Links werden nicht
  mehr nach Kabelanzahl dicker (Anzahl steht im Label); 10M-Links sind bernsteinfarben.
- Port-Hervorhebungen im Rack-Panel der Karte nutzen Ringe statt Leuchteffekte.
- Neue Abhaengigkeit `motion` (ca. +31 kB gzip beim Start).

## v2.1.2 -- Sitzungs-Sicherheit, Scan-Stabilitaet und UI-Polish

**Type:** PATCH

Arbeitsstand, noch nicht veroeffentlicht; Commit-Referenz folgt beim Commit.

### Fixes

- JWT-Pruefungen akzeptieren bei ausgefallenem Redis keine moeglicherweise
  widerrufenen Tokens mehr. Fehlgeschlagene Sitzungswiderrufe liefern einen
  Fehler; Benutzer-Aenderungen und Loeschungen werden dann nicht gespeichert.
- WebSocket-Authentifizierung funktioniert auch beim echten Handshake;
  Einmal-Tickets werden atomar eingeloest und erneut auf Token-Gueltigkeit geprueft.
- Die Authentifizierung verwendet den serverseitig erkannten Pfad statt einer
  aus dem Host-Header rekonstruierten URL. FastAPI/Starlette wurden auf
  0.138.1/1.7.0 aktualisiert; Frontend-Abhaengigkeiten erhalten kompatible Updates.
- Redis speichert Token-Sperren im eigenen Volume mit AOF. Nginx verwirft
  nicht vertrauenswuerdige Forwarding-Header und liefert Security-Header auch
  fuer das SPA-Dokument und statische Dateien aus.
- Logout loescht die lokale Sitzung sofort. Laufende Requests und Token-Refreshes
  koennen Daten oder Zugangsdaten der vorherigen Sitzung nicht zurueckschreiben.
  Der React-Query-Cache wird bei einem Sitzungswechsel geleert.
- Scan-Sperren werden auch bei langen Einzelabfragen erneuert. Ignorierte
  Geraete bleiben bei Voll- und Discovery-Scans ausgeschlossen. Abbruch verhindert
  weitere wartende Ping-Abfragen und Credential-Versuche; abgebrochene Dry-Runs
  behalten ihren Abbruchstatus.
- Ausgeschoepfte Scan-Retries und fehlgeschlagene Queue-Uebergaben erhalten
  einen Fehlerstatus statt dauerhaft als laufend oder wartend zu erscheinen.
- Rack-Teilupdates pruefen Kollisionen mit unveraenderten Geraeten;
  Verkleinern eines Racks darf keine belegten Hoeheneinheiten abschneiden.
- Mobile Ansichten, Sidebar, Login, Dialoge und Karten-Werkzeugleiste erhalten
  verbesserte Platzaufteilung, Beschriftungen und Tastaturbedienung.
- Der veraltete SNMP-Treiber wurde auf PySNMP 7.1.30 mit pyasn1 0.6.4 und
  pyasn1-modules 0.4.2 migriert. Die bekannten ASN.1-Sicherheitsmeldungen sind
  beseitigt; GET/BULK, Credential-Fallbacks und V2c/V3 bleiben erhalten.
- React Router 7.18.4, Vite 8.3.2 und Vitest 4.1.11 ersetzen die verwundbaren
  Frontend-Abhaengigkeiten. Der Frontend-Build verwendet jetzt Node.js 24;
  lokale Entwicklung benoetigt Node.js 22.12 oder eine unterstuetzte neuere Version.
- GitHub prueft Python- und Node-Abhaengigkeiten sowie den Python-Code auf
  Sicherheitsprobleme. Jeder gemeldete Dependency-Fund oder Scan-Fehler sperrt
  Docker-Build und Image-Push; Bandit sperrt ab Schweregrad `medium`.
- Bestehende WebSocket-Verbindungen werden auch bei Leerlauf oder dauerhaftem
  Nachrichtenverkehr fuenf Sekunden nach der letzten erfolgreichen Pruefung
  erneut auf Ablauf und Widerruf geprueft; die Pruefdauer kommt zum Intervall hinzu.
- Bei verlorener Scan-Sperre werden laufende Targets abgebrochen und Transaktionen
  vor Commit sowie nach dem Flush erneut geprueft. Abgebrochene Finalizer werden
  vor dem Schliessen ihrer DB-Session abgewartet; Ping-Prozesse werden beendet.
- Ein konfigurierter Redis-Ausfall aktiviert keine lokale Ersatzsperre mehr.
  Verbindungs- und Antwortzeiten fuer Redis sind begrenzt.

## v2.1.1 -- Offline-Erkennung bei Totalausfall

**Type:** PATCH

### Fixes

- Geraete, die waehrend eines Scans weder auf Ping noch auf SNMP antworten,
  werden jetzt als `offline` markiert. Bisher blieb `ping_status` bei einem
  Totalausfall ewig auf `online` stehen, weil das Geraet nicht mehr im
  Update-Set des Scans auftauchte (`last_ping` wurde ebenfalls nicht
  aktualisiert)

## v2.1.0 -- Firmware-Spalte & Code-Review-Haertung

**Type:** MINOR (neue Alembic-Migration 017, keine Breaking Changes)

### Changes

#### Features

- Firmware-Version wird beim SNMP-Scan erfasst (entPhysicalSoftwareRev mit
  entPhysicalFirmwareRev- und sysDescr-Parsing als Fallback) und als sortierbare,
  durchsuchbare Spalte in der Geraetetabelle auf `/network` angezeigt
- Migration 017: Backfill von `devices.firmware` NULLs plus Server-Default

#### Fixes

##### Backend

- Token-Sperrungen (Logout, Revoke-all) laufen jetzt bis ueber das
  Refresh-Fenster hinaus -- widerrufene Tokens koennen nicht mehr erneuert werden
- Rollenwechsel, Deaktivierung, Passwort-Aenderung und Loeschen sperren alle
  Sessions des betroffenen Users sofort
- WebSocket-Authentifizierung verhaelt sich wie die HTTP-Auth (kein
  Legacy-Token, sobald JWT konfiguriert ist)
- Scan-Lock wird waehrend des Scans und der DB-Finalisierung erneuert;
  Scan-Fortschritt wird live broadcastet statt erst am Ende
- `/api/config/export` erfordert admin/operator; Import loest `profile_label`
  und `device_ip` auf und meldet FK-Fehler als 400 statt 500
- SNMP-Communities werden verschluesselt gespeichert wie die v3-Passwoerter
- Rate-Limiting sieht die echte Client-IP hinter nginx (Proxy-Headers);
  `CORS_ORIGIN` per Env konfigurierbar
- `DeviceOut` serialisiert abgelaufene ORM-Objekte und NULL-Felder robust

##### Frontend

- Job-Polling behandelt `queued` als aktiven Status
- Tabellen-Pagination bleibt bei Refetches erhalten
- Settings-Formulare ueberschreiben ungespeicherte Eingaben nicht mehr
- Karten-Hintergrund synchronisiert sich mit den Settings und nutzt Caching
- IPv6-sichere `ip:port`-Schluessel; Drag-Positionen ueberstehen Refetches
- Rack-Platzierungen werden auf die Rack-Hoehe begrenzt
- Dev-Proxy leitet `/ws` weiter; CSP auf `'self'` verschaerft

## v2.0.0 -- Frontend-Rework & Rack-Elevation

**Type:** MAJOR (Breaking: neuer API-Endpunkt `/api/racks/{id}/layout`, neue DB-Spalten via Migration 015, UI komplett neu aufgebaut)

### Changes

#### Features

- Tailwind-Design-System mit Token-Theme: Dark-Theme als Standard, Light-Theme per Umschalter in der Sidebar
- Neue App-Shell: einklappbare Sidebar, mobiler Drawer, Settings jetzt unter `/settings/:tab` als Sub-Routen
- Dashboard ueberarbeitet: Scan-Hero, Stat-Cards mit Deep-Links, Attention-Card, Verteilungs- und Rack-Uebersicht
- Topology-Map auf React Flow (@xyflow/react) + dagre: Auto-Layout fuer unpositionierte Knoten, Geraetesuche, Minimap, Zoom-Controls, 30s-Live-Refresh mit "aktualisiert vor Xs", aggregierte Link-Badges, einklappbare Rack-Gruppen, persistierte Rack-Positionen
- Echte Rack-Ansicht unter `/racks`: U-Positionen (U1 unten), Drag-and-Drop mit Ghost-Vorschau, Tray fuer nicht zugeordnete Geraete, `u_height`-Stepper, Read-only fuer Viewer; Tastenkuerzel `7`
- Inline-Endpoint-Liste pro Port im Port-Detail-Modal
- DeviceTable/EndpointTable auf gemeinsamer DataTable mit URL-synchronisierten Filtern (`?q=`, `?status=down`); Logs-Seite mit React-Query-Polling
- UI-Primitives (`src/components/ui/`) und TanStack-Query-Hooks (`src/hooks/api/`) als gemeinsame Basis

#### Backend

- Alembic-Migration 015 (`rack_units`): `Rack.height_u` (6..60, Default 42), `Device.rack_u_position`, `Device.u_height`
- Neuer Endpunkt `PATCH /api/racks/{id}/layout`: Bulk-Update des U-Layouts; Fehler 409 `U_OVERLAP` / `U_POSITION_OUT_OF_RANGE`, 422 `DEVICE_NOT_IN_RACK`; Rollen admin/operator
- `DeviceMetaUpdate` akzeptiert `rack_u_position` und `u_height`
- Neue Tests `backend/tests/test_rack_layout.py` (9 Tests)

#### Fixes

- Pan auf der Karte funktioniert auch ohne Hintergrundbild
- Fehlerbehandlung auf der Endpoints-Seite
- `alert()` durch Toast-Benachrichtigungen ersetzt

_Hinweis: Commit-Referenzen werden beim Taggen des Releases ergaenzt._

## v1.16.0 -- Endpoint Table Separation

**Type:** MINOR (new feature, backward-compatible data migration)

### Changes

#### Backend -- Database Schema
- New `endpoints` table: MAC-based identity for discovered end devices (mac, ip, hostname, first_seen, last_seen, ignored, notes)
- New `endpoint_port_associations` table: many-to-many relationship between endpoints and switch ports (with vlan_id, last_seen)
- Removed `is_managed` column from `devices` table (all devices are now network devices)
- Removed `peer_mac`, `peer_ip`, `peer_host`, `endpoint_count`, `endpoint_details_json` columns from `ports` table
- Alembic migration 013: creates new tables, migrates endpoint data from ports/devices, drops old columns

#### Backend -- API
- New `/api/endpoints` router with full CRUD: list (GET), get single (GET), update (PATCH), bulk update (PATCH), delete (DELETE)
- ETag-based caching on endpoint list
- Role-based auth on mutating endpoints
- Audit logging for all endpoint operations
- `/api/stats` now includes `endpoint_count`
- `/api/topology` no longer filters by `is_managed`
- `/api/devices` no longer accepts `role` query parameter

#### Backend -- Scan Engine
- Scan executor now creates `Endpoint` + `EndpointPortAssociation` records instead of storing peer data on ports
- Ping-only discoveries (no switch context) skip Device creation
- New `ENDPOINT_COUNT` Prometheus gauge metric

#### Frontend -- Pages & Components
- New `EndpointTable` component: dedicated table for endpoint devices with MAC, IP, hostname, timestamps, found-on-port, ignore/bulk-ignore
- DevicesPage now renders `EndpointTable` (fetches from `/api/endpoints`)
- `DeviceTable` simplified to network-only (removed role prop, found_on logic, endpoint columns)
- NetworkPage simplified (no role prop)
- Settings tabs (RacksTab, SwitchClassesTab, SwitchModelsTab) updated to fetch `/api/devices` without role filter

#### Frontend -- Types
- Added `Endpoint` and `EndpointPortInfo` interfaces
- Removed `FoundOnPort` and `EndpointDetail` interfaces
- Removed `is_managed` from `TopologyNode`
- Removed `peer_mac`, `peer_ip`, `peer_host`, `endpoint_details_json` from `PortInfo`
- Removed `role` from `DeviceTableProps`

#### Testing
- New `test_endpoints.py`: endpoint CRUD, bulk update, delete with cascade
- Updated `test_topology.py`: removed `is_managed` references, added devices list test
- Updated `test_cascade.py`: added endpoint cascade tests (device->port->association, endpoint->association)
- Updated `test_settings.py`: added `endpoint_count` assertion
- Updated `test_schemas.py`: added endpoint schema validation tests
- New `EndpointTable.test.tsx`: endpoint table rendering and found_on display
- Updated `DeviceTable.test.tsx`: removed role prop

### Files Modified
| File | Change |
|------|--------|
| `backend/database.py` | Added Endpoint, EndpointPortAssociation models; removed is_managed, peer_* columns |
| `backend/alembic/versions/013_separate_endpoints.py` | Migration: create tables, migrate data, drop columns |
| `backend/schemas.py` | Added EndpointOut, EndpointPortInfo, EndpointUpdate, BulkEndpointUpdate; removed FoundOnPort |
| `backend/routers/endpoints.py` | New CRUD router for /api/endpoints |
| `backend/routers/topology.py` | Removed is_managed filter and role param |
| `backend/main.py` | Registered endpoints router |
| `backend/scan_engine/executor.py` | Endpoint/association creation instead of peer_* storage |
| `backend/routers/settings.py` | Added endpoint_count to stats |
| `backend/shared/metrics.py` | Added ENDPOINT_COUNT gauge |
| `backend/seed_db.py` | Removed is_managed and peer_* from seed data |
| `frontend/src/types.ts` | Added Endpoint types, removed legacy types |
| `frontend/src/components/DeviceTable.tsx` | Simplified to network-only |
| `frontend/src/components/EndpointTable.tsx` | New endpoint table component |
| `frontend/src/pages/DevicesPage.tsx` | Uses EndpointTable |
| `frontend/src/pages/NetworkPage.tsx` | Removed role prop |
| `frontend/src/components/settings/RacksTab.tsx` | Removed ?role=network |
| `frontend/src/components/settings/SwitchClassesTab.tsx` | Removed ?role=network |
| `frontend/src/components/settings/SwitchModelsTab.tsx` | Removed ?role=network |
| `backend/tests/test_endpoints.py` | New endpoint CRUD tests |
| `backend/tests/test_topology.py` | Removed is_managed references |
| `backend/tests/test_cascade.py` | Added endpoint cascade tests |
| `backend/tests/test_settings.py` | Added endpoint_count assertion |
| `backend/tests/test_schemas.py` | Added endpoint schema tests |
| `frontend/src/__tests__/DeviceTable.test.tsx` | Removed role prop |
| `frontend/src/__tests__/EndpointTable.test.tsx` | New endpoint table tests |

---

## v1.15.1 -- Device-Credential Sync Fix

**Type:** PATCH (bug fix)

### Changes

#### Backend -- Device -> Credential Sync
- `update_device_meta()` now syncs `rack_id`/`class_id` to the matching Credential record
- `bulk_update_device_meta()` now syncs `rack_id`/`class_id` to all affected Credential records
- Both updates are committed in a single transaction for atomicity

#### Frontend -- ETag Invalidation
- RacksTab, SwitchClassesTab, SwitchModelsTab now invalidate `/api/credentials` cache on assign/unassign

#### Testing
- Added `test_update_device_meta_syncs_credential` and `test_bulk_update_device_meta_syncs_credentials`

### Files Modified
| File | Change |
|------|--------|
| `backend/routers/topology.py` | Credential sync in `update_device_meta()` and `bulk_update_device_meta()` |
| `frontend/src/components/settings/RacksTab.tsx` | Added `/api/credentials` to ETag invalidation |
| `frontend/src/components/settings/SwitchClassesTab.tsx` | Added `/api/credentials` to ETag invalidation |
| `frontend/src/components/settings/SwitchModelsTab.tsx` | Added `/api/credentials` to ETag invalidation |
| `backend/tests/test_topology.py` | Added sync tests |

---

## v1.15.0 -- P1 Quality, Security, and TypeScript

**Type:** MINOR (config consolidation, security hardening, TypeScript expansion, test coverage)

### Changes

#### Backend -- Configuration & Logging
- Centralized Pydantic BaseSettings config module (`config.py`) covering all 15 env vars across 8 files
- Fixed REDIS_URL default inconsistency between celery_app.py and redis_client.py
- Configurable `LOG_LEVEL` env var (was hardcoded to INFO)
- Added `pydantic-settings>=2.0.0` dependency

#### Backend -- Security
- JWT tokens now include `jti` (UUID) and `iat` (issued-at) claims
- Redis-based JTI blacklist for token revocation with TTL matching token lifetime
- `POST /api/auth/logout` -- blacklist current token
- `POST /api/auth/revoke-all` -- admin-only, invalidate all sessions for a user
- User-level revocation: all tokens issued before revocation timestamp are rejected
- Token blacklist check in `_require_auth()` middleware

#### Backend -- Health Check
- Enhanced `/health` endpoint checks DB (SELECT 1), Redis (PING), Celery (control.ping with 2s timeout)
- Returns `{"status": "ok"|"degraded", "checks": {...}}` with HTTP 503 on degraded

#### Frontend -- TypeScript Migration (batch 2)
- Created `types.ts` with 11 shared interfaces (TopologyNode, PortInfo, TopologyLink, etc.)
- Migrated `store.js` to `store.ts` with typed Zustand `create<NetmapState>`
- Migrated 4 hooks to TypeScript: useMapBackground, useRackOrders, useScanProgress, useTopologyData
- Migrated 7 page files to TypeScript: Dashboard, Devices, Login, Logs, Map, Network, Settings
- Complete TypeScript migration: all 23 remaining .jsx/.js files migrated across 5 waves (styles, leaf, settings, core, complex+shell)
- Frontend logout now calls backend `/api/auth/logout` before clearing localStorage

#### Frontend -- New Features
- Lazy loading: React.lazy() for 7 page components with Suspense loading spinner
- Toast notification system: ToastProvider context, useToast hook, 4 types, auto-dismiss, stacked bottom-right
- Keyboard shortcuts: useKeyboardShortcuts hook (1-6 nav, Escape blur/close, S scan)

#### Backend -- P2 Quality
- Audit log retention: `AUDIT_RETENTION_DAYS` config (default 90), Celery Beat cleanup every 6h, admin purge endpoint
- Request logging middleware: opt-in via `REQUEST_LOG_ENABLED`, logs method/path/status/duration, skips health/metrics/ws
- Graceful shutdown: `_shutdown_requested` event in scheduler, lifespan cleanup, Celery worker_shutting_down signal

#### DevOps
- Database backup/restore scripts: `scripts/backup.sh` and `scripts/restore.sh` with pg_dump/psql via Docker
- `BACKUP.md` documentation with cron setup and retention cleanup
- `backups/` added to .gitignore

#### Testing
- Backend: +35 new tests (62 -> 97), 6 new test files
- Frontend: +8 new tests (3 -> 11), 3 new test files + test utilities
- Total: 108 tests across both suites
- New test coverage: topology router, settings router, health check, config module, token revocation, DNS module (9 tests), ping module (6 tests)
- Frontend component tests: LoginPage (3), DashboardPage (3), DeviceTable (2)
- P1 test expansion: +116 backend tests (97 -> 213), bringing backend coverage above 60%
- Scanner plugin tests (49): extract_model, is_virtual_port, fdb_strategy, registry, edge cases
- DB helpers tests (9): safe_json_list, canonical_link_key, expand_ranges, read_discovery_ranges, persist_scan_run
- CRUD tests (20): racks (7), switch classes (6), switch models (7)
- Map background tests (11): upload, SVG sanitization, XSS stripping, delete, settings
- Audit logging tests (7): list, limit, side-effect on credential operations
- WebSocket tests (7): auth unit tests (disabled, legacy, token, ticket, JWT, expired)
- Scan jobs tests (5): dispatch checks, state lifecycle, cancel handling
- CASCADE delete tests (4): device->ports, scan_run->metrics, rack/class nullification

### Files Created
| File | Purpose |
|------|---------|
| backend/config.py | Centralized Pydantic BaseSettings configuration |
| frontend/src/types.ts | Shared TypeScript interfaces |
| frontend/src/store.ts | Typed Zustand store |
| frontend/src/hooks/useMapBackground.ts | Typed hook |
| frontend/src/hooks/useRackOrders.ts | Typed hook |
| frontend/src/hooks/useScanProgress.ts | Typed hook |
| frontend/src/hooks/useTopologyData.ts | Typed hook |
| frontend/src/pages/DevicesPage.tsx | Typed page component |
| frontend/src/pages/NetworkPage.tsx | Typed page component |
| frontend/src/pages/LoginPage.tsx | Typed page component |
| frontend/src/pages/LogsPage.tsx | Typed page component |
| frontend/src/pages/DashboardPage.tsx | Typed page component |
| frontend/src/pages/MapPage.tsx | Typed page component |
| frontend/src/pages/SettingsPage.tsx | Typed page component |
| frontend/src/__tests__/test-utils.tsx | Test utilities (renderWithRouter, API mocks) |
| frontend/src/__tests__/LoginPage.test.tsx | LoginPage component tests |
| frontend/src/__tests__/DashboardPage.test.tsx | DashboardPage component tests |
| frontend/src/__tests__/DeviceTable.test.tsx | DeviceTable component tests |
| backend/tests/test_config_module.py | Config module tests |
| backend/tests/test_token_revocation.py | Token revocation tests |
| backend/tests/test_topology.py | Topology router tests |
| backend/tests/test_settings.py | Settings router tests |
| backend/tests/test_dns.py | DNS module tests |
| backend/tests/test_ping.py | Ping module tests |

### Files Modified
| File | Change |
|------|--------|
| backend/database.py | Config import replaces os.getenv |
| backend/celery_app.py | Config import replaces os.getenv |
| backend/main.py | Config import, configurable LOG_LEVEL |
| backend/shared/auth.py | Config import, JTI/iat claims, blacklist functions |
| backend/shared/crypto.py | Config import replaces os.getenv |
| backend/shared/redis_client.py | Config import replaces os.getenv |
| backend/routers/ws.py | Config import replaces os.getenv |
| backend/routers/auth.py | Logout + revoke-all endpoints |
| backend/routers/health.py | Enhanced DB/Redis/Celery checks |
| backend/alembic/env.py | Config import replaces os.getenv |
| backend/requirements.txt | Added pydantic-settings |
| backend/tests/test_health.py | Updated for new health response structure |
| frontend/src/api.ts | Async logout with backend call |
| frontend/src/main.jsx | Updated page imports for .tsx |

---

## v1.14.0 -- Architecture and Infrastructure

**Type:** MINOR (internal restructuring, no user-facing API changes)

### Changes

#### Backend Architecture
- Scanner plugin auto-discovery via `__init_subclass__` -- adding a new scanner now requires only creating one file with `vendor_id=` keyword (CQ-8)
- Topology query optimization: credential IP set replaced with SQL subquery, eliminating one DB round-trip per request (PC-2)
- Scan engine modularized into 8-module package (`scan_engine/`): broadcast, event_loop, ping, dns, db_helpers, executor, jobs, scheduler -- all existing imports remain unchanged via `__init__.py` re-exports (CQ-2)
- Celery Beat scheduler migration: new `scheduler_tick` periodic task replaces thread-based scheduler when Redis is available; thread fallback preserved for local dev (AD-2)
- New `celery-beat` Docker service in docker-compose.yml

#### Frontend Architecture
- Design tokens file (`styles/tokens.js`) centralizes colors, spacing, radii, fonts, and shadows
- Shared style objects (`styles/shared.js`) provide reusable card, input, button, and table styles
- TypeScript infrastructure: `tsconfig.json` with strict mode, `api.js` migrated to `api.ts` with full type annotations
- Added `typecheck` npm script (`tsc --noEmit`)

### Files Created
| File | Purpose |
|------|---------|
| backend/scan_engine/__init__.py | Package re-exports for backward compatibility |
| backend/scan_engine/broadcast.py | WebSocket progress broadcasting |
| backend/scan_engine/event_loop.py | Shared background asyncio loop |
| backend/scan_engine/ping.py | ICMP ping utilities |
| backend/scan_engine/dns.py | DNS resolution and caching |
| backend/scan_engine/db_helpers.py | DB write utilities for scan results |
| backend/scan_engine/executor.py | Core async scan execution |
| backend/scan_engine/jobs.py | Job management (thread/Celery dispatch) |
| backend/scan_engine/scheduler.py | Background scan scheduler |
| frontend/src/styles/tokens.js | Design tokens |
| frontend/src/styles/shared.js | Shared style objects |
| frontend/tsconfig.json | TypeScript configuration |
| frontend/src/api.ts | Typed API layer (replaces api.js) |

### Files Modified
| File | Change |
|------|--------|
| backend/scanners/base.py | `_registry`, `vendor_id`, `__init_subclass__` hook |
| backend/scanners/aruba_cx.py | `vendor_id="aruba_cx"` keyword |
| backend/scanners/fs_scanner.py | `vendor_id="fs"` keyword |
| backend/scanners/unifi.py | `vendor_id="unifi"` keyword |
| backend/scanners/opnsense.py | `vendor_id="opnsense"` keyword |
| backend/scanners/generic.py | `vendor_id="generic"` keyword |
| backend/scanners/__init__.py | Auto-discovery via pkgutil |
| backend/routers/topology.py | Credential IP subquery (2 locations) |
| backend/tasks.py | `scheduler_tick` Celery task |
| backend/celery_app.py | `beat_schedule` configuration |
| backend/main.py | Conditional scheduler thread |
| docker-compose.yml | `celery-beat` service |
| frontend/package.json | TypeScript devDependencies, typecheck script |
| 23 frontend files | Import path update (api.js -> api) |

### Files Deleted
| File | Reason |
|------|--------|
| backend/scan_engine.py | Replaced by scan_engine/ package |

### Breaking Changes
- Docker: new `celery-beat` service required (runs `celery -A celery_app beat`). Without it, the thread-based scheduler still works as fallback when Redis is unavailable.

---

## v1.13.0 — Security Enhancements, Frontend Polish, Performance

**Type:** MINOR (security enhancements, frontend polish, performance)

### Changes

#### Security
- WebSocket ticket-based auth: new `POST /api/auth/ws-ticket` endpoint exchanges JWT for single-use Redis-backed ticket (30s TTL) for WebSocket connections
- JWT token refresh: new `POST /api/auth/refresh` endpoint accepts expired tokens within 60-minute grace window, frontend auto-refreshes 30 minutes before expiry
- Rate limiting expanded: credentials CRUD (10/min), settings write (10/min), user management (10/min), dry-run jobs (3/min)
- Dry-run endpoint (`POST /api/scan/dry-run/jobs`) now requires admin/operator authentication (was previously unauthenticated)

#### Frontend
- Map settings tab: loading spinner and error states added
- SNMP profiles tab: load error display added
- Silent `.catch(() => {})` and `console.error` catches replaced with user-visible error messages in SettingsPage
- New `extractErrorMessage()` utility removes "Error: " prefix -- applied across 9 component files (15 replacements)

#### Performance
- Topology ETag: version counter replaces SHA-256 hash of full response body
- Scan completion now bumps topology version for proper cache invalidation
- Credential CRUD operations (create/update/delete) now bump topology version

### Files Modified
| File | Change |
|------|--------|
| backend/routers/auth.py | ws-ticket endpoint, refresh endpoint, rate limits |
| backend/routers/ws.py | Ticket-based auth |
| backend/routers/scan.py | Dry-run auth + rate limit |
| backend/routers/settings.py | Rate limit |
| backend/routers/credentials.py | Rate limits, topo version bump |
| backend/routers/topology.py | Version-counter ETag |
| backend/shared/auth.py | /api/auth/refresh exempt path |
| backend/scan_engine.py | Topo version bump after scan |
| backend/tests/test_auth.py | 7 new tests |
| frontend/src/api.js | refreshTokenIfNeeded, extractErrorMessage |
| frontend/src/hooks/useScanProgress.js | Ticket exchange |
| frontend/src/pages/SettingsPage.jsx | Error/loading states |
| frontend/src/components/settings/MapSettingsTab.jsx | Loading/error props |
| frontend/src/components/settings/SnmpProfilesTab.jsx | loadError prop |
| 7 more settings/component files | extractErrorMessage |

### Breaking Changes
- `POST /api/scan/dry-run/jobs` now requires authentication (admin/operator role)
- ETag format changed from SHA-256 hash to `"v{N}"` (harmless cache miss on first request)

---

## v1.12.0 — Security Hardening and Code Quality

**Type:** MINOR (security hardening and code quality improvements)

### Changes

#### Security Fixes
- Auth bypass fix: `request.state.user` is now explicitly set when auth is disabled (SEC-1)
- CRITICAL startup logs when `JWT_SECRET`/`SECRET_TOKEN` or `ENCRYPTION_KEY` are not configured (SEC-1, SEC-2)
- Hardcoded default passwords replaced with mandatory env vars in docker-compose.yml; added `.env.example` (SEC-3)
- Bulk and config import now encrypts SNMP passwords before storing (CB-1)
- Rate limiting on login endpoint (5/min) via slowapi (SEC-4)
- Password complexity validation: minimum 8 characters for user creation/update (SEC-7)
- Community strings masked in bulk and config exports (SEC-8)
- `/metrics` endpoint now requires authentication (SEC-6)
- IP validation for credential creation rejects shell-dangerous characters (SEC-11)
- Rate limiting on map background upload (5/min) (SEC-12)
- Improved CORS wildcard warning with remediation guidance (SEC-14)

#### Code Quality
- Audit logger (`shared/audit.py`) accepts optional `db` session parameter for atomic logging (CB-2)
- JWT token expiry utility functions added to frontend API client (SEC-13)
- ETag cache batch eviction (20%) replaces single-entry eviction (PC-4)
- DNS cache size limit (10,000 entries) with eviction in scan engine (PC-3)

#### Infrastructure
- Celery worker Docker health check added (IF-3)
- Log rotation (json-file driver, 10m max, 3 files) for all Docker services (IF-4)
- Redis wait block added to entrypoint.sh (IF-5)
- TLS/HTTPS production deployment documentation in README (IF-1)

#### Testing
- 32 new tests: authentication/RBAC (15), bulk import/export (9), config import/export (8)
- Test coverage increased from ~2% to ~43%
- pytest-cov configured with 10% minimum coverage threshold
- `requires_postgres` marker registered for PostgreSQL-specific tests

### Files Created
| File | Description |
|------|-------------|
| .env.example | Environment variable template with required/recommended labels |
| backend/tests/test_auth.py | Auth and RBAC tests (15 tests) |
| backend/tests/test_bulk.py | Bulk import/export tests (9 tests) |
| backend/tests/test_config.py | Config import/export tests (8 tests) |

### Files Modified
| File | Change |
|------|--------|
| backend/shared/auth.py | Auth bypass fix, startup security warnings |
| backend/main.py | Rate limiting setup, CORS warning, metrics auth |
| backend/routers/auth.py | Login rate limit, password complexity validation |
| backend/routers/bulk.py | SNMP password encryption on import, community string masking on export |
| backend/routers/config.py | SNMP password encryption on import, community string masking on export |
| backend/routers/map_bg.py | Rate limiting on upload endpoint |
| backend/shared/audit.py | Optional db session parameter for atomic logging |
| backend/scan_engine.py | DNS cache size limit with eviction, ETag batch eviction |
| backend/schemas.py | Password complexity validation |
| backend/entrypoint.sh | Redis wait block |
| backend/pytest.ini | pytest-cov configuration, requires_postgres marker |
| backend/requirements.txt | Added slowapi, pytest-cov dependencies |
| backend/tests/conftest.py | Shared test fixtures and configuration |
| docker-compose.yml | Mandatory env vars, log rotation, Celery health check |
| README.md | TLS/HTTPS production deployment documentation |
| frontend/src/api.js | JWT token expiry utility functions |

### Breaking Changes
- docker-compose.yml now requires `POSTGRES_PASSWORD`, `SECRET_TOKEN`, and `DEFAULT_ADMIN_PASSWORD` to be set in `.env` file
- `/metrics` endpoint now requires authentication (update Prometheus scrape config)

---

## v1.11.1 — Congruence Fixes

**Type:** PATCH (bug fixes)

### Changes

#### PortOut Schema: tagged_vlans field
- Added `tagged_vlans: Optional[List[int]] = None` to `PortOut` Pydantic schema so the field is serialized in API responses.
- Added `"tagged_vlans": []` to the `_coerce_nulls` defaults dict for null-safety.

#### Settings Navigation: Devices tab
- Added "Devices" entry to the INFRASTRUCTURE group in `NAV_GROUPS` so the already-implemented `DevicesTab` is reachable from the sidebar.

#### Store Default Topology: models key
- Added `models: []` to the default `topology` state in the Zustand store for consistency with `TopologyOut`.

### Files Modified
| File | Change |
|------|--------|
| backend/schemas.py | Added `tagged_vlans` field and null-coercion default to `PortOut` |
| frontend/src/pages/SettingsPage.jsx | Added Devices entry to `NAV_GROUPS` INFRASTRUCTURE group |
| frontend/src/store.js | Added `models: []` to default topology state |

---

## v1.11.0 — Slide-In Switch Detail Panel

**Type:** MINOR (new feature)

### Changes

#### Slide-In Switch Detail Panel
- Switch detail view converted from separate page route to slide-in panel overlay on map.
- [i] button color fixed for visibility (#475569 -> #94a3b8, border #1e293b -> #334155).
- Removed /switch/:id route and deleted SwitchDetailPage.jsx.
- Panel slides in from the right with backdrop overlay and CSS animation.
- Sortable 9-column port table preserved from previous implementation.

### Files Created
| File | Description |
|------|-------------|
| frontend/src/components/SwitchDetailSlideIn.jsx | Slide-in panel component with sortable port table |

### Files Modified
| File | Change |
|------|--------|
| frontend/src/pages/MapPage.jsx | Added detailSwitchId state, import, render of SwitchDetailSlideIn, pass onShowDetail to RackDetail |
| frontend/src/components/map/RackDetail.jsx | Accept and thread onShowDetail prop to SwitchPanel |
| frontend/src/components/SwitchPanel.jsx | Replaced useNavigate with onShowDetail callback, fixed [i] button color |
| frontend/src/main.jsx | Removed SwitchDetailPage import and /switch/:id route |

### Files Deleted
| File | Reason |
|------|--------|
| frontend/src/pages/SwitchDetailPage.jsx | Replaced by SwitchDetailSlideIn component |

---

## v1.10.0 — Switch Detail Page

**Type:** MINOR (new feature, superseded by v1.11.0)

### Changes

#### Per-Switch Detail Page
- New `/switch/:id` route with full port table for any switch, accessible via `[i]` button on each switch panel in the rack overview.
- Switch header card showing name, IP, vendor, model, location, ping status, RTT, and active port count.
- Sortable 9-column port table: port number, name, status, speed, native VLAN, tagged VLANs, MAC address, IP, hostname.
- Loading state when topology is not yet fetched (auto-loads on direct URL navigation).
- Not-found state with back button when device ID is invalid.
- Dark theme matching existing style tokens.

### Files Created
| File | Description |
|------|-------------|
| frontend/src/pages/SwitchDetailPage.jsx | Full switch detail page with sortable port table |

### Files Modified
| File | Change |
|------|--------|
| frontend/src/main.jsx | Added SwitchDetailPage import and `/switch/:id` route inside App layout |
| frontend/src/components/SwitchPanel.jsx | Added `[i]` details button with useNavigate to `/switch/:id` |

---

## v1.9.0 — Tagged VLAN Collection

**Type:** MINOR (new feature)

### Changes

#### Tagged VLAN Support
- Added SNMP collection of tagged (trunked) VLAN memberships per port using Q-BRIDGE-MIB bitmask OIDs (`dot1qVlanStaticEgressPorts` / `dot1qVlanStaticUntaggedPorts`).
- New `snmp_bulk_walk_raw()` function for binary OCTET STRING bitmask data (preserves raw bytes instead of decoding to string).
- New `parse_port_bitmask()` helper to convert Q-BRIDGE port bitmasks into sets of bridge port numbers.
- Tagged VLANs computed as `EgressPorts - UntaggedPorts` per VLAN, mapped back to ifIndex via bridge port table.
- Two bitmask walks executed in parallel via `asyncio.gather` for performance.
- Graceful fallback: tagged VLAN walk failure does not break existing PVID collection.
- `tagged_vlans` JSONB column added to `ports` table (Alembic migration 011).
- `tagged_vlans` field added to `IfInfo` dataclass, `PortOut` schema, and scan engine port persistence.
- Frontend: port tooltip and detail modal now display tagged VLANs alongside native VLAN.

### Files Created
| File | Description |
|------|-------------|
| backend/alembic/versions/011_add_tagged_vlans.py | Migration adding tagged_vlans JSONB column to ports |

### Files Modified
| File | Change |
|------|--------|
| backend/snmp_scanner.py | Added OID constants, snmp_bulk_walk_raw(), parse_port_bitmask(), tagged_vlans field on IfInfo, step 6b tagged VLAN collection |
| backend/database.py | Added tagged_vlans JSONB column to Port model |
| backend/scan_engine.py | Added tagged_vlans to port_rows persistence |
| backend/schemas.py | Added tagged_vlans to PortOut schema with null coercion |
| frontend/src/components/Port.jsx | Added tagged VLANs display in tooltip |
| frontend/src/components/PortDetailModal.jsx | Added tagged VLANs row in detail modal |

---

## v1.8.1 — Alembic Migration Fixes + Map Background Upload

**Type:** PATCH (bug fixes)

### Changes

#### Alembic Migration Chain Repair
- Fixed duplicate revision ID "003" that caused `alembic upgrade head` to fail with "Multiple head revisions". Renumbered `003_add_switch_class_allow_outside_rack.py` to `003b` and chained it after the cascade migration.
- Added `ondelete="CASCADE"` to `dry_run_results.scan_run_id` FK (model + new migration 010) to prevent IntegrityError when deleting scan runs.
- Fixed `scan_max_workers` seed value from '4' to '12' in migration 005 to match database.py.
- Added `compare_type=True` to `alembic/env.py` for better autogenerate column type detection.
- Corrected impossible date metadata in migration docstrings (003, 004, 005).

#### Map Background Upload Fix
- Fixed auth token not being sent on upload: replaced broken `import.meta.env.VITE_API_TOKEN` with shared `_getAuthHeader()` reading from localStorage (same pattern as all other API calls).
- Added `client_max_body_size 25m` to nginx `/api/` location block (default 1 MB was blocking uploads).
- Added error handling: upload failures now show error detail via alert instead of silently ignoring.
- Added `/api/map-background` to auth-exempt paths so browser-native `<image>` requests can load the background without auth headers (POST/DELETE remain role-guarded).

### Files Created
| File | Description |
|------|-------------|
| backend/alembic/versions/010_dry_run_cascade.py | Migration adding CASCADE to dry_run_results FK |

### Files Modified
| File | Change |
|------|--------|
| backend/alembic/versions/003b_add_switch_class_allow_outside_rack.py | Renamed from 003, updated revision chain |
| backend/alembic/versions/004_jsonb_snapshot_columns.py | Updated down_revision to "003b" |
| backend/alembic/versions/005_settings_to_db.py | Fixed scan_max_workers seed, date |
| backend/alembic/versions/003_add_cascade_deletes.py | Fixed docstring date |
| backend/alembic/env.py | Added compare_type=True |
| backend/database.py | Added ondelete="CASCADE" to DryRunResult FK |
| backend/shared/auth.py | Added /api/map-background to auth-exempt paths |
| frontend/src/api.js | Exported _getAuthHeader() |
| frontend/src/pages/SettingsPage.jsx | Fixed upload auth + error handling |
| frontend/nginx.conf | Added client_max_body_size 25m |

---

## v1.8.0 — Port Endpoint Data (MAC/IP on Hover)

**Type:** MINOR (new feature)

### Changes

#### Port Endpoint Data Population
- **MAC-only endpoints**: Ports now show MAC addresses even when no IP is available (FDB data without ARP).
- **Global ARP table**: ARP tables from all scanned devices (especially routers) are merged and shared across L2 switches, enabling IP resolution for MACs on pure L2 switches.
- **IP-MIB unified fallback**: When legacy ARP table (ipNetToMediaTable) returns empty, the scanner falls back to the unified IP-MIB neighbor table (ipNetToPhysicalPhysAddress). Resolves ARP for OPNsense/FreeBSD and modern devices.
- **LLDP port filtering**: MAC-only entries are skipped on ports with LLDP neighbors (interswitch/uplink links) to avoid transit MAC noise.
- **Diagnostic logging**: SNMP walk result counts (ARP MAC/IP, bridge port, FDB rows) and final endpoint table sizes are logged for each device.
- **Smart sorting**: When multiple endpoints exist on a port, entries with IPs sort first for primary display.

### Files Modified
| File | Change |
|------|--------|
| backend/snmp_scanner.py | Diagnostic logging after ARP/FDB walks, IP-MIB unified neighbor table fallback |
| backend/scan_engine.py | MAC-only endpoint loop, LLDP port filtering, global ARP merge, updated sort key |

---

## v1.7.0 — Phase 6 & 7: Observability, Operations, and Remaining Items

**Type:** MINOR (new features + infrastructure)

### Changes

#### 6.1 Prometheus Metrics
- Added `prometheus-client>=0.20.0` to requirements.txt.
- Created `backend/shared/metrics.py` with Histogram, Counter, and Gauge metrics for scans, devices, ports, and HTTP requests.
- Added `MetricsMiddleware` to `main.py` recording request latency and total counts per method/endpoint/status (excludes /metrics itself).
- Added `GET /metrics` endpoint (auth-exempt, excluded from schema) returning Prometheus text format.
- Instrumented `scan_engine.py`: SCAN_ACTIVE inc/dec, SCAN_DURATION/SCAN_TOTAL at completion, DEVICE_COUNT/PORT_COUNT gauge updates after each scan.
- Added `/metrics` to `_AUTH_EXEMPT_PATHS` in `shared/auth.py`.

#### 6.2 CI/CD Pipeline
- Expanded `.github/workflows/ci.yml` with lint-backend (ruff), test-backend (pytest), test-frontend (vitest), docker-build (on push to main), docker-push (on tags v*).
- Created `backend/pyproject.toml` with ruff config (line-length=120, target-version=py312, select E/W/F/I, ignore E501).

#### 7.1 Credential Fallback Chains
- Created migration `008_credential_fallback.py`: adds `priority` column, drops unique on `ip`, adds composite unique on `(ip, priority)`.
- Updated `Credential` model in `database.py`: added `priority` column, `UniqueConstraint("ip", "priority")`, removed `unique=True` from `ip`.
- Updated `schemas.py`: added `priority` field to `CredentialBase`, `CredentialCreate`, `CredentialUpdate`.
- Updated `routers/credentials.py`: duplicate check now uses `(ip, priority)` instead of just `ip`.
- Updated `scan_engine.py`: credentials loaded ordered by priority, grouped by IP; scan tries primary then fallback credentials in order.
- Updated `CredentialsTab.jsx`: added priority field to form and edit flow.

#### 7.2 Bulk Device Operations
- Added `BulkDeviceMetaUpdate` schema to `schemas.py`.
- Added `PATCH /api/topology/devices/bulk-meta` endpoint to `topology.py`.
- Updated `DevicesTab.jsx`: checkbox per device row, bulk action toolbar (Ignore Selected, Re-enable Selected, Clear), Select All per section.

#### 7.3 Dry-Run Persistence
- Added `DryRunResult` model to `database.py`.
- Created migration `009_dry_run_results.py`.
- Updated `scan_engine.py` dry-run block to persist preview via `_persist_scan_run` + `DryRunResult`.
- Added `GET /api/scan-runs/{run_id}/dry-run-preview` endpoint to `scan_runs.py`.
- Added `DryRunPreviewItem` schema to `schemas.py`.

### Files Created
| File | Description |
|------|-------------|
| backend/shared/metrics.py | Prometheus metric definitions |
| backend/pyproject.toml | Ruff linter configuration |
| backend/alembic/versions/008_credential_fallback.py | Migration for credential priority + fallback |
| backend/alembic/versions/009_dry_run_results.py | Migration for dry-run results table |

### Files Modified
| File | Change |
|------|--------|
| backend/requirements.txt | Added prometheus-client |
| backend/main.py | MetricsMiddleware + /metrics endpoint |
| backend/shared/auth.py | /metrics added to auth-exempt paths |
| backend/shared/metrics.py | NEW: Prometheus metric definitions |
| backend/scan_engine.py | Prometheus instrumentation, credential fallback chains, dry-run persistence |
| backend/database.py | Credential priority + UniqueConstraint, DryRunResult model |
| backend/schemas.py | priority field, BulkDeviceMetaUpdate, DryRunPreviewItem |
| backend/routers/credentials.py | Duplicate check on (ip, priority) |
| backend/routers/topology.py | PATCH /api/topology/devices/bulk-meta |
| backend/routers/scan_runs.py | GET /api/scan-runs/{run_id}/dry-run-preview |
| .github/workflows/ci.yml | Expanded CI/CD pipeline |
| frontend/src/components/settings/CredentialsTab.jsx | Priority field in form |
| frontend/src/components/settings/DevicesTab.jsx | Selection + bulk actions |

---

## v1.6.0 — Phase 1: Foundation (Architecture Improvements)

**Type:** MINOR (new infrastructure + structural improvements)

### Changes

#### 1.1 Structured Error Responses
- Created `backend/shared/errors.py` with `api_error()` helper for consistent error format.
- Added `ErrorDetail`, `APIError` Pydantic schemas to `schemas.py`.
- Added global exception handlers in `main.py` for both `Exception` and `HTTPException`.
- Updated all 11 router files (14 total endpoints) from raw `HTTPException` to structured `api_error()`.
- Updated `shared/auth.py` to return structured error on auth failure.
- Updated `frontend/src/api.js` `_checkOk` to parse `body.error.message`.

#### 1.2 Comprehensive Input Validation
- Added 8 Pydantic models: `ScanSettingsUpdate/Out`, `DnsSettingsUpdate/Out`, `DiscoveryRangesUpdate/Out`, `MapSettingsUpdate/Out`.
- Rewrote `scan_settings.py` to use Pydantic request bodies instead of `request.json()`.
- Updated `map_bg.py` to use `MapSettingsUpdate` body model.

#### 1.3 Consolidate Settings into Database
- Created Alembic migration `005_settings_to_db.py` for new setting keys.
- Rewrote `shared/file_settings.py` from file-based (portalocker) to DB-backed settings via `AppSetting` table.
- Updated `database.py` `_seed_default_settings()` with 7 new setting keys.
- Removed `portalocker` dependency from `requirements.txt`.

#### 1.4 Test Infrastructure Setup
- Created `backend/tests/` package with `conftest.py` (SQLite in-memory, auth fixtures, DB override).
- Created `test_health.py`, `test_credentials.py` (7 CRUD tests), `test_schemas.py` (7 validation tests).
- Added `pytest`, `pytest-asyncio`, `httpx` to `requirements.txt`.
- Added `pytest.ini` for test configuration.
- Made `database.py` engine creation backend-aware (PostgreSQL pool params vs SQLite).

### Files Created
| File | Description |
|------|-------------|
| backend/shared/errors.py | Structured error response helper |
| backend/alembic/versions/005_settings_to_db.py | Migration for DB-backed settings |
| backend/tests/__init__.py | Test package init |
| backend/tests/conftest.py | Shared test fixtures |
| backend/tests/test_health.py | Health endpoint test |
| backend/tests/test_credentials.py | Credential CRUD tests |
| backend/tests/test_schemas.py | Schema validation tests |
| backend/pytest.ini | Pytest configuration |

### Files Modified
| File | Change |
|------|--------|
| backend/schemas.py | Added ErrorDetail, APIError, 8 settings schemas |
| backend/main.py | Structured exception handlers |
| backend/database.py | Conditional engine params, 7 new seed settings |
| backend/shared/auth.py | Structured error format |
| backend/shared/file_settings.py | Complete rewrite to DB-backed |
| backend/requirements.txt | Removed portalocker, added test deps |
| backend/routers/*.py | All 11 router files updated to api_error() |
| frontend/src/api.js | Parse structured error messages |

---

## v1.5.0 — Rack Class Section Reorder

**Type:** MINOR (new feature)

### Changes

#### Rack Detail: Class Section Order Controls
- Added `^` / `v` controls on each class section header in rack detail panel.
- Class section order is now reorderable per rack and persisted in `localStorage`.
- Works for dynamic class sections (`class:<id>`) plus `Other` (unclassified).

### Files Modified
| File | Change |
|------|--------|
| frontend/src/components/map/RackDetail.jsx | Class header reorder controls + local immediate ordering |
| frontend/src/hooks/useRackOrders.js | Persist class-section order per rack (`__class_sections__`) |
| frontend/src/pages/MapPage.jsx | Wire class-section reorder callback into rack detail |

---

## v1.4.0 — Dynamic Rack Class Sections

**Type:** MINOR (new feature)

### Changes

#### Rack Detail: Unlimited Class Groups
- Removed hardcoded rack sections for only Top-of-Rack and Access.
- Rack detail panel now renders a section for every class that is present in the selected rack (`class_id`-based grouping).
- Unclassified devices remain visible in a dedicated `Other` section.
- Reorder persistence now supports dynamic class keys (e.g. `class:<id>`) instead of only `tor/access/other`.

### Files Modified
| File | Change |
|------|--------|
| frontend/src/components/map/RackDetail.jsx | Dynamic per-class sections and render flow |
| frontend/src/hooks/useRackOrders.js | Dynamic class-key reorder support |
| frontend/src/pages/MapPage.jsx | Pass dynamic rack order groups to RackDetail |

---

## v1.3.1 — Rack Detail Reorder Fix

**Type:** PATCH (bug fix)

### Changes

#### Rack Detail: Switch Reorder Buttons
- Fixed non-functional reorder behavior in rack detail panel (`^` / `v`) caused by ID type mismatches (`number` vs `string`) in localStorage order comparisons.
- `frontend/src/hooks/useRackOrders.js`: normalized all compared/stored device IDs via `String(id)` and added a safe guard for missing `selectedRack.devices`.
- `frontend/src/components/map/RackDetail.jsx`: normalized `deviceOrder` IDs to strings before sorting, so persisted order is applied reliably.

### Files Modified
| File | Change |
|------|--------|
| frontend/src/hooks/useRackOrders.js | Normalize reorder IDs and guard missing devices |
| frontend/src/components/map/RackDetail.jsx | Normalize sort comparison IDs |

---

## v1.3.0 — PostgreSQL Migration + Device Ignore Flag

**Type:** MINOR (new infrastructure + new feature)

### Changes

#### PostgreSQL Migration
- Replaced SQLite with PostgreSQL 16-alpine for improved concurrency and write performance.
- `docker-compose.yml`: added `postgres:16-alpine` service with TCP healthcheck and `netmap-pgdata` named volume.
- `backend/database.py`: PostgreSQL engine with connection pooling (`pool_size=10`, `max_overflow=20`, `pool_pre_ping=True`, `pool_recycle=300`). Fixed `INSERT OR IGNORE` → `INSERT ... ON CONFLICT (key) DO NOTHING` for PostgreSQL compatibility.
- `backend/requirements.txt`: `psycopg2-binary>=2.9.9` added.
- `backend/Dockerfile`: `libpq5` runtime dependency added; removed SQLite `DATABASE_URL` ENV default.
- `backend/entrypoint.sh`: replaced SQLite stamp-head detection with PostgreSQL TCP readiness wait loop (up to 60 seconds on port 5432).
- `backend/alembic/env.py`: removed SQLite-only `render_as_batch=True` and `compare_type=False` workarounds.
- `backend/alembic/versions/002_add_device_ignored.py`: `server_default="false"` (was `"0"` for SQLite Boolean).
- `backend/scan_engine.py`: port inserts use `bulk_insert_mappings` instead of individual `db.add()` calls.
- `migrate_sqlite_to_pg.py`: one-shot data migration script (SQLite → PostgreSQL, column-for-column copy with boolean casting and sequence reset).

#### Device Ignore Flag
- Added `ignored BOOLEAN NOT NULL DEFAULT false` column to `devices` table via Alembic migration `002`.
- `GET /api/topology`: filters out ignored devices (`Device.ignored == False`).
- `GET /api/devices`: new endpoint returning all devices including ignored ones.
- `PATCH /api/devices/{id}/meta`: supports `ignored` field.
- `CredentialsTab.jsx`: shows "ignored" badge per device row; Ignore/Re-enable button per row.

#### Assign Dropdown Fixes
- ETag cache invalidation (`api.invalidate()`) called before `refreshAll()` after assign/unassign in settings tabs.
- Assign dropdowns: only show unassigned devices with `ports.length > 0` (successfully scanned).

### Files Modified
| File | Change |
|------|--------|
| docker-compose.yml | PostgreSQL service, pgdata volume |
| backend/database.py | PostgreSQL engine, connection pooling, INSERT ON CONFLICT fix |
| backend/requirements.txt | psycopg2-binary |
| backend/Dockerfile | libpq5, remove SQLite ENV |
| backend/entrypoint.sh | PostgreSQL readiness wait |
| backend/alembic/env.py | Remove SQLite workarounds |
| backend/alembic/versions/002_add_device_ignored.py | NEW — devices.ignored column |
| backend/scan_engine.py | bulk_insert_mappings for ports |
| backend/routers/topology.py | Filter ignored devices; GET /api/devices endpoint |
| frontend/src/api.js | api.invalidate() method |
| frontend/src/components/settings/CredentialsTab.jsx | Ignore/Re-enable button, ignored badge |
| migrate_sqlite_to_pg.py | NEW — one-shot SQLite→PostgreSQL data migration |

---

## v1.2.1 — SNMP Scanner Fix + Topology Map Rendering Fixes

**Type:** PATCH (critical bug fixes)

### Changes

#### Backend: pysnmp-lextudio 5.x API Fix
- Fixed `snmp_bulk_walk` in `backend/snmp_scanner.py`: pysnmp-lextudio 5.x changed `bulkCmd` from an async iterator to a single awaitable Future. Rewrote the function to use a manual loop with repeated `await bulkCmd(...)` calls.
- Fixed `var_binds` indexing: in v5.x each element of `var_binds` is `[ObjectType]` (a single-element list), not `ObjectType` directly. Added `vb = row[0] if isinstance(row, (list, tuple)) else row` unwrap in both `snmp_bulk_walk` and `snmp_get`.
- Result: All 25 switches now return correct interface counts (e.g. 67 ifaces, 2 LLDP nbrs) and 907+ ports are populated in the database.

#### Frontend: Topology Map Port/Link Display Fixes
- `api.js`: Added `normPort()` export for case/whitespace-normalised port name comparison. Used in `buildPortLinkMap`. Added `structuredClone` for ETag cache to prevent reference aliasing.
- `SwitchPanel.jsx`, `Port.jsx`, `RackDetail.jsx`: Import and use `normPort()` in all port key constructions.
- `MapPage.jsx`: Added `selectedRackFull` memo so `RackDetail` always receives a fully-populated device list even after device moves.
- `TopologyMap.jsx`: Build `ipToRackId` map from unfiltered nodes + managedRacks. Added null guards for `onMouseUp` and `d.ports`.
- `useTopologyData.js`: Simplified `loadTopology` to prevent stale-device sync issues.

### Files Modified
| File | Change |
|------|--------|
| backend/snmp_scanner.py | Rewritten `snmp_bulk_walk` (manual loop); fixed `var_binds` indexing in `snmp_get` |
| backend/scan_engine.py | `remote_port` normalization: suffix-based matching resolves LLDP abbreviations to canonical `if_descr` |
| frontend/src/api.js | `normPort()` export; `structuredClone` ETag cache |
| frontend/src/hooks/useTopologyData.js | Simplified `loadTopology` |
| frontend/src/components/SwitchPanel.jsx | `normPort` in pKey |
| frontend/src/components/Port.jsx | `normPort` in highlight keys |
| frontend/src/components/map/RackDetail.jsx | `normPort` in `useEffect` for dotted-line lookup; unclassified links shown as uplinks |
| frontend/src/pages/MapPage.jsx | `selectedRackFull` memo |
| frontend/src/components/map/TopologyMap.jsx | `ipToRackId` from unfiltered nodes + guards |

---

## v1.2.0 — Frontend Split + Alembic Migrations

**Type:** MINOR (structural refactoring + new migration framework)

### Changes
- Split `frontend/src/pages/SettingsPage.jsx` (2149 lines) into 9 focused tab components in `frontend/src/components/settings/`.
- Split `frontend/src/pages/MapPage.jsx` (1126 lines) into 4 sub-components and 3 custom hooks.
  - New components: `TopologyMap`, `RackDetail`, `FilterBar`, `ActiveLinkBar` in `frontend/src/components/map/`.
  - New hooks: `useTopologyData`, `useMapBackground`, `useRackOrders` in `frontend/src/hooks/`.
- Added **Alembic** database migration framework (`alembic==1.13.3`).
  - `backend/alembic/` directory with `env.py` (SQLite batch mode), `script.py.mako`, and `versions/001_initial_schema.py` (all 11 tables).
  - `entrypoint.sh` auto-detects pre-Alembic databases, stamps them at head, then runs `alembic upgrade head` on every container start.
  - All 7 ad-hoc `_ensure_*` DDL functions removed from `database.py` and replaced by proper migrations.
  - `_seed_default_settings()` preserved for idempotent `app_settings` row seeding.
- Verified: all 12 API endpoints return 200 after all changes.

### Files Created/Modified
| File | Change |
|------|--------|
| frontend/src/components/settings/ (9 files) | NEW — tab components extracted from SettingsPage.jsx |
| frontend/src/pages/SettingsPage.jsx | 2149 lines → ~100 lines |
| frontend/src/components/map/ (4 files) | NEW — sub-components extracted from MapPage.jsx |
| frontend/src/hooks/ (3 files) | NEW — custom hooks extracted from MapPage.jsx |
| frontend/src/pages/MapPage.jsx | 1126 lines → 146 lines |
| backend/alembic.ini | NEW |
| backend/alembic/env.py | NEW |
| backend/alembic/script.py.mako | NEW |
| backend/alembic/versions/001_initial_schema.py | NEW |
| backend/database.py | Removed 7 _ensure_* functions, added _seed_default_settings() |
| backend/entrypoint.sh | Added alembic stamp + upgrade head logic |
| backend/requirements.txt | Added alembic==1.13.3 |

---

## v1.1.0 — Backend Router Split Refactoring

**Type:** MINOR (structural refactoring — no API surface changes)

### Changes
- Split `backend/main.py` (2123 lines) into a clean router-based structure.
- New thin `backend/main.py` (53 lines): app factory and wiring only.
- New `backend/scan_engine.py` (968 lines): all scan engine logic, background scheduler, ping/DNS helpers, job management.
- New `backend/shared/state.py`: `LOG_BUFFER`, `SCAN_JOBS`, `_log_event()`.
- New `backend/shared/auth.py`: `SECRET_TOKEN`, `_bearer`, `_require_auth()`.
- New `backend/shared/file_settings.py`: all file-system constants and read/write helpers for map, scan, and DNS settings.
- New `backend/routers/` package (15 router files): `health`, `settings`, `credentials`, `snmp_profiles`, `racks`, `switch_classes`, `switch_models`, `scan`, `scan_runs`, `topology`, `map_bg`, `scan_settings`, `bulk`, `config`, `logs`.
- All route handler logic copied verbatim — no functional changes.
- All API endpoints verified 200 OK after refactoring via Docker smoke test.

### Files Created/Modified
| Lines | File |
|------:|------|
| 53 | backend/main.py |
| 968 | backend/scan_engine.py |
| 137 | backend/shared/file_settings.py |
| 31 | backend/shared/state.py |
| 19 | backend/shared/auth.py |
| 0 | backend/shared/__init__.py |
| 207 | backend/routers/bulk.py |
| 160 | backend/routers/config.py |
| 121 | backend/routers/topology.py |
| 83 | backend/routers/scan_settings.py |
| 81 | backend/routers/map_bg.py |
| 66 | backend/routers/credentials.py |
| 62 | backend/routers/scan.py |
| 58 | backend/routers/scan_runs.py |
| 54 | backend/routers/snmp_profiles.py |
| 48 | backend/routers/racks.py |
| 48 | backend/routers/switch_classes.py |
| 48 | backend/routers/switch_models.py |
| 47 | backend/routers/settings.py |
| 29 | backend/routers/logs.py |
| 9 | backend/routers/health.py |
| 0 | backend/routers/__init__.py |

---

## v1.0.0 — Initial Release

- Monolithic `backend/main.py` (2123 lines) FastAPI application.
- SNMP-based network topology discovery and mapping.
- Frontend React/Vite SPA served via Nginx.
- SQLite database via SQLAlchemy.
- Docker Compose deployment.
