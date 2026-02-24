# Analysis: Ignore Flag & Scan-Filtered Assign-Dropdown

## 1. Aktuelles Datenbankschema — Device-Felder

Tabelle `devices` (ORM: `backend/database.py`, DDL: `alembic/versions/001_initial_schema.py`):

| Feld | Typ | Beschreibung |
|---|---|---|
| id | Integer PK | |
| sys_name | String | SNMP sysName |
| ip | String UNIQUE | Management-IP |
| sys_descr | Text | |
| model | String | |
| vendor | String | |
| location | String | |
| ping_status | String | online / offline / unknown |
| ping_rtt_ms | Integer | |
| last_ping | DateTime | |
| map_x | Float | |
| map_y | Float | |
| last_seen | DateTime | |
| rack_id | Integer FK | |
| class_id | Integer FK | |
| model_id | Integer FK | |

**Kein `ignored`-Feld vorhanden.** Eine Alembic-Migration ist zwingend notwendig.

---

## 2. Ignored-Feld: Existenz & Migrationsbedarf

- `database.py` Device-Klasse: **kein** `ignored`-Feld
- `alembic/versions/001_initial_schema.py`: **kein** `ignored`-Column in der `devices`-Tabelle
- `schemas.py` `DeviceBase` / `DeviceOut` / `DeviceMetaUpdate`: **kein** `ignored`-Feld

**Fazit:** Neue Alembic-Migration `002_add_device_ignored.py` ist erforderlich:
```python
op.add_column("devices", sa.Column("ignored", sa.Boolean(), nullable=False, server_default="0"))
```
SQLite erlaubt `ADD COLUMN` mit einem Default, also kein Table-Rebuild nötig.

---

## 3. Definition "hat erfolgreichen Scan" (Feature 1)

Ein Switch gilt als "auslesbar" (hat gültige SNMP-Credentials und wurde mindestens einmal erfolgreich gescannt), wenn **mindestens ein Port in der `ports`-Tabelle** für dieses Device existiert.

**Begründung:**
- Ports werden in `scan_engine.py` nur dann geschrieben, wenn `scan_switch()` echte Interface-Daten zurückgibt (`sw.interfaces`).
- Ein Device ohne Ports wurde entweder nur per Ping entdeckt (`Discovered by ping (SNMP unavailable)`) oder wurde noch nie erfolgreich gescannt.
- Die Relation `Device.ports` ist bereits vorhanden (`lazy="selectin"`), d.h. `len(device.ports) > 0` ist sofort verfügbar auf jedem `DeviceOut`-Objekt.

**Frontend-Filterlogik (einfach):**
```js
const scannedDevices = devices.filter(d => d.ports && d.ports.length > 0);
```

**Alternativ-Definition via `ScanRunSwitchMetric`:**
- `ScanRunSwitchMetric.success == True` für eine bestimmte IP zeigt, dass der letzte Scan erfolgreich war — aber das erfordert einen DB-Join und ist komplexer.
- Die `ports.length > 0`-Prüfung ist robuster und braucht keinen Extra-Endpoint.

---

## 4. Backend-Änderungen

### 4.1 Neue Alembic-Migration: `002_add_device_ignored.py`

```python
revision = "002"
down_revision = "001"

def upgrade():
    op.add_column("devices", sa.Column("ignored", sa.Boolean(), nullable=False, server_default="0"))

def downgrade():
    op.drop_column("devices", "ignored")
```

### 4.2 `database.py` — Device-Model

```python
ignored = Column(Boolean, default=False, nullable=False)
```

### 4.3 `schemas.py` — Anpassungen

**`DeviceBase`:** `ignored: bool = False` hinzufügen

**`DeviceOut`:** erbt von `DeviceBase`, also automatisch enthalten

**`DeviceMetaUpdate`:** `ignored: Optional[bool] = None` hinzufügen

### 4.4 `routers/topology.py` — Zwei Änderungen

**a) `GET /api/topology` — Ignored-Devices herausfiltern:**
```python
nodes = db.query(Device).filter(Device.ignored == False).all()
```
Ignored Devices sollen aus der Topologie-Karte verschwinden.

**b) `PATCH /api/topology/devices/{device_id}/meta` — `ignored`-Feld unterstützen:**
```python
if "ignored" in payload:
    device.ignored = payload["ignored"]
```

**Neuer Endpunkt (optional aber empfohlen): `GET /api/devices` — Alle Devices inkl. Ignored**

Damit die Settings-Seite (Switches-Tab) auch ignorierte Geräte sehen und verwalten kann, braucht sie alle Devices, nicht nur nicht-ignorierte. Optionen:
- `GET /api/topology?include_ignored=true` — Query-Parameter
- `GET /api/devices` — neuer separater Endpunkt (sauberer)

**Empfehlung:** neuer Endpunkt `GET /api/devices` in `routers/topology.py` oder einem neuen Router `routers/devices.py`:
```python
@router.get("/api/devices", response_model=List[DeviceOut])
def list_devices(db: Session = Depends(get_db)):
    """Returns all devices including ignored ones (for settings UI)."""
    devices = db.query(Device).all()
    ...
```

### 4.5 `scan_engine.py` — Ignored Devices überspringen

In `_execute_scan()` werden Credentials geladen, und dann Devices gescannt. Der Scan läuft über `Credential`-Objekte, nicht direkt über `Device`-Objekte. Der Filter muss daher an zwei Stellen greifen:

**a) Credential-Loading** (Zeile ~253 in `scan_engine.py`):
```python
# Zusätzlicher Filter: IPs von ignored Devices überspringen
ignored_ips = {d.ip for d in db.query(Device.ip).filter(Device.ignored == True).all()}
credentials = db.query(Credential).filter(
    Credential.enabled == True,
    ~Credential.ip.in_(ignored_ips)
).all()
```

**b) Auch im Background-Scheduler:** Keine eigene Logik nötig, da `_execute_scan()` verwendet wird.

**c) Port-Update:** Wenn ein Device auf `ignored=True` gesetzt wird, bleiben bestehende Ports erhalten (historische Daten). Das ist gewünscht — beim Zurücksetzen auf `ignored=False` sind die alten Port-Daten noch da.

---

## 5. Frontend-Änderungen

### 5.1 Feature 1: Dropdown-Filter "nur auslesbare Switches"

**Betroffene Dateien:**
- `frontend/src/components/settings/RacksTab.jsx`
- `frontend/src/components/settings/SwitchClassesTab.jsx`
- `frontend/src/components/settings/SwitchModelsTab.jsx`

**Aktueller Code in allen drei Tabs (identisches Muster):**
```jsx
const available = devices.filter(d => d.rack_id !== rack.id);  // bzw. class_id / model_id
```

**Neue Filterlogik:**
```jsx
// Nur Devices mit mindestens einem Port (= erfolgreicher SNMP-Scan)
const scannedDevices = devices.filter(d => d.ports && d.ports.length > 0);
const available = scannedDevices.filter(d => d.rack_id !== rack.id);
```

**Kein neuer Backend-Endpunkt nötig** — `DeviceOut` enthält bereits `ports: List[PortOut]` (lazy="selectin" in DB, wird immer mitgeladen in `/api/topology`).

### 5.2 Feature 2: Ignore-Toggle — Neue Seite oder bestehender Tab?

**Analyse der bestehenden Tabs:**
- `switches` (CredentialsTab): Zeigt Credentials (Zugangsdaten), nicht Devices. Credentials und Devices sind getrennte Tabellen.
- `racks`, `classes`, `models`: Zeigen jeweils ihre Entitäten mit Assign-Dropdowns für Devices.

**Empfehlung: Neuer Settings-Tab "Device Settings"**

Ein neuer Tab im INFRASTRUCTURE-Bereich der SettingsPage:
```
INFRASTRUCTURE
  Switches      (Credentials)
  Device Settings  [NEU]  -> "Scan settings per discovered device"
  Racks
  Classes
  Models
```

Alternativ könnte der Ignore-Toggle in den `CredentialsTab` integriert werden (da Credentials 1:1 mit gescannten Devices verknüpft sind), aber:
- Ein Credential kann existieren, ohne dass ein Device existiert (noch nie gescannt)
- Ein Device kann existieren, ohne Credential (per Ping entdeckt, kein SNMP)
- Der Ignore-Toggle betrifft das **Device**, nicht das Credential

**Neuer Tab: `DeviceSettingsTab.jsx`**

Inhalt:
- Liste aller bekannten Devices (alle, inkl. ignored) von neuem `GET /api/devices`
- Pro Device: Name/IP, Ping-Status, Port-Anzahl, Ignored-Toggle
- Toggle ruft `PATCH /api/topology/devices/{id}/meta` mit `{ ignored: true/false }` auf
- Ignored Devices werden visuell markiert (z.B. ausgegraut, Badge "Ignored")

**Datenabruf:** Neuer Endpunkt `GET /api/devices` (alle Devices, auch ignored) oder `GET /api/topology?include_ignored=true`

### 5.3 Topologie-Karte

- `GET /api/topology` filtert bereits `Device.ignored == False` nach Backend-Änderung
- Keine Änderung an `TopologyMap.jsx` oder `useTopologyData.js` nötig — Ignored Devices kommen schlicht nicht mehr in der Response vor

---

## 6. Neuer Tab "Device Settings" vs. bestehende Tabs

### Pro neuer Tab:
- Trennung der Concerns: Credentials (Zugangsdaten) vs. Device-Einstellungen (Scan-Verhalten)
- Übersichtlicher: Alle Devices auf einen Blick mit Ignore-Toggle
- Kein Durcheinander mit dem Credential-Tab
- Kann in Zukunft weitere Device-spezifische Settings aufnehmen (z.B. Custom Scan Interval)

### Pro Integration in bestehenden Tab:
- CredentialsTab kennt bereits Devices (lädt `/api/topology`)
- Weniger neue Dateien
- Aber: Credentials und Devices sind semantisch unterschiedlich

### Entscheidung: Neuer Tab empfohlen

Tab-Name: **"Devices"** (unter INFRASTRUCTURE, nach "Switches")
Beschreibung: `"Scan behavior per device"`

---

## 7. Vollständige Änderungsübersicht

### Backend (5 Dateien)

| Datei | Änderung |
|---|---|
| `alembic/versions/002_add_device_ignored.py` | NEU: Migration `ignored BOOLEAN DEFAULT FALSE` |
| `database.py` | `Device.ignored = Column(Boolean, default=False)` |
| `schemas.py` | `DeviceBase.ignored`, `DeviceMetaUpdate.ignored` |
| `routers/topology.py` | GET filter `ignored==False`, PATCH unterstützt `ignored`, neuer GET /api/devices |
| `scan_engine.py` | Skip Credentials deren Device.ip `ignored==True` ist |

### Frontend (5 Dateien)

| Datei | Änderung |
|---|---|
| `components/settings/RacksTab.jsx` | Assign-Dropdown: nur `ports.length > 0` Devices |
| `components/settings/SwitchClassesTab.jsx` | Assign-Dropdown: nur `ports.length > 0` Devices |
| `components/settings/SwitchModelsTab.jsx` | Assign-Dropdown: nur `ports.length > 0` Devices |
| `components/settings/DeviceSettingsTab.jsx` | NEU: Ignore-Toggle pro Device |
| `pages/SettingsPage.jsx` | Neuen Tab "Devices" registrieren, `DeviceSettingsTab` importieren |

### Alembic-Migration Version

Aktuell: `001` (initial schema)
Neu: `002_add_device_ignored`

---

## 8. Offene Fragen / Design-Entscheidungen

1. **Ignored Devices aus Topology-Response herausfiltern oder per Flag senden?**
   - Empfehlung: Herausfiltern (einfacher, keine Frontend-Änderung nötig). Nur der neue `/api/devices`-Endpunkt zeigt alle inkl. ignored.

2. **Beim Setzen auf `ignored=True`: Ports löschen oder behalten?**
   - Empfehlung: Behalten (historische Daten, Rücknahme möglich).

3. **Beim Setzen auf `ignored=True`: Credential `enabled` automatisch auf `False` setzen?**
   - Empfehlung: Nein — Credential und Device sind getrennte Entitäten. Der Scan-Engine-Filter greift direkt auf die `ignored`-Flag des Devices.

4. **Assign-Dropdown-Filter: Was passiert mit bereits zugewiesen Devices, die keine Ports haben?**
   - Diese bleiben zugewiesen (der Filter betrifft nur das Dropdown für neue Assignments). Bereits zugewiesene Devices werden weiterhin in der "Assigned"-Liste angezeigt.
