# Implementation Plan: Ignore-Flag & Scan-Filtered Assign-Dropdown

## Overview

Two features:
- **Feature 1**: Assign-Dropdowns in RacksTab, SwitchClassesTab, SwitchModelsTab zeigen nur Switches, die mindestens einen Port haben (`ports.length > 0`).
- **Feature 2**: `ignored`-Flag fur Devices — Alembic-Migration, Backend-Filter, neuer Endpunkt, Scan-Engine-Skip, Frontend-Tab.

---

## Gesamte Dateienubersicht

| Nr | Datei | Typ | Anderung |
|----|-------|-----|---------|
| 1  | `backend/alembic/versions/002_add_device_ignored.py` | NEU | Migration: `ignored BOOLEAN NOT NULL DEFAULT 0` |
| 2  | `backend/database.py` | EDIT | `Device.ignored` Column hinzufugen |
| 3  | `backend/schemas.py` | EDIT | `ignored` Feld in `DeviceBase` und `DeviceMetaUpdate` |
| 4  | `backend/routers/topology.py` | EDIT | GET filtert ignored, PATCH unterstutzt ignored, neuer GET /api/devices |
| 5  | `backend/scan_engine.py` | EDIT | Skip ignored Devices beim Scannen |
| 6  | `frontend/src/components/settings/RacksTab.jsx` | EDIT | available-Filter auf `ports.length > 0` |
| 7  | `frontend/src/components/settings/SwitchClassesTab.jsx` | EDIT | available-Filter auf `ports.length > 0` |
| 8  | `frontend/src/components/settings/SwitchModelsTab.jsx` | EDIT | available-Filter auf `ports.length > 0` |
| 9  | `frontend/src/components/settings/DevicesTab.jsx` | NEU | Devices-Liste mit Ignore-Toggle |
| 10 | `frontend/src/pages/SettingsPage.jsx` | EDIT | Neuen "Devices"-Tab registrieren |

---

## Schritt-fur-Schritt Checkliste

---

### SCHRITT 1 — Alembic-Migration erstellen

**Datei:** `backend/alembic/versions/002_add_device_ignored.py` (NEU erstellen)

```python
"""Add ignored column to devices table.

Revision ID: 002
Revises: 001
Create Date: 2026-02-24

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("ignored", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("devices", "ignored")
```

**Wichtig:**
- `server_default="0"` statt `default=False` — SQLite versteht `"0"` als False bei BOOLEAN.
- SQLite erlaubt `ADD COLUMN` mit einem `server_default`, also kein Table-Rebuild notig.
- `down_revision = "001"` — korrekte Verkettung an die bestehende Migration.

**Checklist:**
- [ ] Datei `backend/alembic/versions/002_add_device_ignored.py` mit obigem Inhalt erstellen

---

### SCHRITT 2 — database.py: ignored-Column zum Device-ORM hinzufugen

**Datei:** `backend/database.py`

**Ziel-Stelle:** In der `Device`-Klasse nach `last_seen` und vor `rack_id` (Zeile ~164):

```python
    last_seen    = Column(DateTime, default=datetime.utcnow)

    # Ignore flag: wenn True, wird das Device beim Scan ubersprungen
    # und nicht in der Topologie-Karte angezeigt
    ignored      = Column(Boolean, default=False, nullable=False)

    # Optional assignment to a managed rack and switch class
    rack_id      = Column(Integer, ForeignKey("racks.id"), nullable=True)
```

**Konkreter Replace:**
- `oldString`: Ab `last_seen    = Column(DateTime, default=datetime.utcnow)` bis `    # Optional assignment to a managed rack and switch class`
- `newString`: Gleiche Zeilen + neue `ignored`-Zeile davor

**Checklist:**
- [ ] `ignored = Column(Boolean, default=False, nullable=False)` nach `last_seen` in `Device`-Klasse einfugen

---

### SCHRITT 3 — schemas.py: ignored Feld hinzufugen

**Datei:** `backend/schemas.py`

**a) `DeviceBase`-Klasse finden** (Klasse, von der `DeviceOut` erbt). Prufung: `DeviceBase` enthalt `map_x` und `map_y` (Zeile ~248-250 in schemas.py).

Aktuell (Zeile ~249-251):
```python
    map_x:     float = 100.0
    map_y:     float = 100.0
```

Neu — `ignored` nach `map_y` hinzufugen:
```python
    map_x:     float = 100.0
    map_y:     float = 100.0
    ignored:   bool  = False
```

**b) `DeviceMetaUpdate`-Klasse** (Zeile ~273-282 in schemas.py):

Aktuell:
```python
class DeviceMetaUpdate(BaseModel):
    location: Optional[str] = None
    sys_name: Optional[str] = None
    vendor:   Optional[str] = None
    model:    Optional[str] = None
    rack_id:  Optional[int] = None
    class_id: Optional[int] = None
    model_id: Optional[int] = None
```

Neu — `ignored` am Ende hinzufugen:
```python
class DeviceMetaUpdate(BaseModel):
    location: Optional[str] = None
    sys_name: Optional[str] = None
    vendor:   Optional[str] = None
    model:    Optional[str] = None
    rack_id:  Optional[int] = None
    class_id: Optional[int] = None
    model_id: Optional[int] = None
    ignored:  Optional[bool] = None
```

**Checklist:**
- [ ] `ignored: bool = False` in `DeviceBase` nach `map_y` einfugen
- [ ] `ignored: Optional[bool] = None` in `DeviceMetaUpdate` am Ende einfugen

---

### SCHRITT 4 — topology.py: GET filtert ignored, PATCH unterstutzt ignored, neuer GET /api/devices

**Datei:** `backend/routers/topology.py`

#### 4a) GET /api/topology — ignorierte Devices herausfiltern

Aktuell (Zeile 21):
```python
    nodes   = db.query(Device).all()
```

Neu:
```python
    nodes   = db.query(Device).filter(Device.ignored == False).all()
```

#### 4b) PATCH /api/topology/devices/{device_id}/meta — `ignored`-Feld unterstutzen

Am Ende des `payload`-Block in `update_device_meta` (nach dem `if "model_id" in payload:` Block, Zeile ~115):

```python
    if "model_id" in payload:
        model_id = payload["model_id"]
        if model_id is not None and not db.query(SwitchModelModel).filter(SwitchModelModel.id == model_id).first():
            raise HTTPException(404, "Switch model not found")
        device.model_id = model_id
    if "ignored" in payload:
        device.ignored = payload["ignored"]

    db.commit()
```

#### 4c) Neuer Endpunkt GET /api/devices

Neuen Import hinzufugen: `List` aus `typing` (prufen ob bereits vorhanden — falls nicht, hinzufugen).
`schemas.py` Import: `DeviceOut` ist bereits importiert.

Neuen Router-Endpunkt am Ende der Datei (nach dem letzten `return`-Statement) hinzufugen:

```python
@router.get("/api/devices")
def list_all_devices(db: Session = Depends(get_db)):
    """Returns all devices including ignored ones (for the settings UI)."""
    devices = db.query(Device).order_by(Device.ip).all()
    # Resolve ports_per_row from switch models
    models = db.query(SwitchModelModel).all()
    model_ppr = {m.id: m.ports_per_row for m in models}
    result = []
    for d in devices:
        dout = DeviceOut.model_validate(d)
        if d.model_id and d.model_id in model_ppr:
            dout.ports_per_row = model_ppr[d.model_id]
        result.append(dout)
    from schemas import DeviceOut as _DO
    import json
    body = json.dumps([d.model_dump() for d in result], default=str)
    return Response(content=body, media_type="application/json")
```

**Hinweis:** Da `topology.py` bereits `Response` und `json` (via hashlib) importiert, muss `json` noch explizit importiert werden. Aktuell wird `hashlib` verwendet aber kein `json`. Daher:

Am Import-Block oben in `topology.py`:
```python
"""Topology query and device/rack position/meta update endpoints."""
import hashlib
import json
```

**Checklist:**
- [ ] `import json` am Anfang von `topology.py` hinzufugen (nach `import hashlib`)
- [ ] `nodes = db.query(Device).filter(Device.ignored == False).all()` in GET /api/topology
- [ ] `if "ignored" in payload: device.ignored = payload["ignored"]` in PATCH-Handler
- [ ] Neuen `GET /api/devices` Endpunkt am Ende von `topology.py` hinzufugen

---

### SCHRITT 5 — scan_engine.py: Ignored Devices beim Scan uberspringen

**Datei:** `backend/scan_engine.py`

**Ziel-Stelle:** In `_execute_scan()` Zeile ~260-264, wo Credentials geladen werden.

Aktuell:
```python
    if scan_mode in {"ports", "links", "macs"}:
        # Only scan credentials that are already in the Device table
        known_ips = {d.ip for d in db.query(Device.ip).all()}
        credentials = db.query(Credential).filter(Credential.enabled == True, Credential.ip.in_(known_ips)).all()
    else:
        credentials = db.query(Credential).filter(Credential.enabled == True).all()
```

Neu — `ignored`-IPs in beiden Pfaden herausfiltern:
```python
    # Collect IPs of ignored devices to skip them in all scan modes
    ignored_ips = {d.ip for d in db.query(Device).filter(Device.ignored == True).all()}

    if scan_mode in {"ports", "links", "macs"}:
        # Only scan credentials that are already in the Device table
        known_ips = {d.ip for d in db.query(Device.ip).all()} - ignored_ips
        credentials = db.query(Credential).filter(Credential.enabled == True, Credential.ip.in_(known_ips)).all()
    else:
        credentials = db.query(Credential).filter(
            Credential.enabled == True,
            ~Credential.ip.in_(ignored_ips),
        ).all()
```

**Checklist:**
- [ ] `ignored_ips` Set vor dem `if scan_mode` Block berechnen
- [ ] `known_ips` in ports/links/macs-Pfad um `ignored_ips` bereinigen
- [ ] Discovery/full-Pfad mit `~Credential.ip.in_(ignored_ips)` filtern

---

### SCHRITT 6 — Frontend: RacksTab.jsx — Assign-Dropdown filtert nur Devices mit Ports

**Datei:** `frontend/src/components/settings/RacksTab.jsx`

**Ziel-Stelle:** Zeile ~95 im Map-Callback uber die `racks`:

Aktuell:
```jsx
        const assigned  = devices.filter(d => d.rack_id === rack.id);
        const available = devices.filter(d => d.rack_id !== rack.id);
```

Neu:
```jsx
        const assigned  = devices.filter(d => d.rack_id === rack.id);
        const scanned   = devices.filter(d => d.ports && d.ports.length > 0);
        const available = scanned.filter(d => d.rack_id !== rack.id);
```

**Begründung:** `d.ports` ist in `DeviceOut` immer vorhanden (lazy="selectin" im ORM, `ports: List[PortOut] = []` im Schema). Nur Devices mit mindestens einem Port werden im Dropdown angeboten. Bereits zugewiesene Devices ohne Ports bleiben in der `assigned`-Liste sichtbar.

**Checklist:**
- [ ] `scanned`-Variable einfugen, `available` aus `scanned` ableiten in `RacksTab.jsx`

---

### SCHRITT 7 — Frontend: SwitchClassesTab.jsx — Assign-Dropdown filtert nur Devices mit Ports

**Datei:** `frontend/src/components/settings/SwitchClassesTab.jsx`

**Ziel-Stelle:** Zeile ~102 im Map-Callback uber die `switchClasses`:

Aktuell:
```jsx
        const available = devices.filter(d => d.class_id !== sc.id);
```

Neu:
```jsx
        const scanned   = devices.filter(d => d.ports && d.ports.length > 0);
        const available = scanned.filter(d => d.class_id !== sc.id);
```

**Checklist:**
- [ ] `scanned`-Variable einfugen, `available` aus `scanned` ableiten in `SwitchClassesTab.jsx`

---

### SCHRITT 8 — Frontend: SwitchModelsTab.jsx — Assign-Dropdown filtert nur Devices mit Ports

**Datei:** `frontend/src/components/settings/SwitchModelsTab.jsx`

**Ziel-Stelle:** Zeile ~119 im Map-Callback uber die `switchModels`:

Aktuell:
```jsx
        const available = devices.filter(d => d.model_id !== sm.id);
```

Neu:
```jsx
        const scanned   = devices.filter(d => d.ports && d.ports.length > 0);
        const available = scanned.filter(d => d.model_id !== sm.id);
```

**Checklist:**
- [ ] `scanned`-Variable einfugen, `available` aus `scanned` ableiten in `SwitchModelsTab.jsx`

---

### SCHRITT 9 — Frontend: DevicesTab.jsx erstellen (NEU)

**Datei:** `frontend/src/components/settings/DevicesTab.jsx` (NEU)

**Zweck:** Zeigt alle Devices (inkl. ignored) mit Ignore-Toggle.

**Datenquelle:** `GET /api/devices` (neuer Backend-Endpunkt, liefert alle Devices inkl. ignored)

**Toggle-Aktion:** `PATCH /api/topology/devices/{id}/meta` mit `{ ignored: true/false }`

**Vollstandiger Inhalt der neuen Datei:**

```jsx
import { useState, useEffect } from "react";
import { api } from "../../api.js";

export default function DevicesTabContent() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState({});

  const refresh = () => {
    setLoading(true);
    api.get("/api/devices")
      .then(d => { setDevices(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const toggleIgnored = async (device) => {
    setToggling(prev => ({ ...prev, [device.id]: true }));
    try {
      await api.patch(`/api/topology/devices/${device.id}/meta`, { ignored: !device.ignored });
      refresh();
    } finally {
      setToggling(prev => ({ ...prev, [device.id]: false }));
    }
  };

  const ROW_BASE = {
    display: "flex", alignItems: "center", gap: 12,
    padding: "8px 12px", borderRadius: 6, marginBottom: 4,
    border: "1px solid #1e293b",
  };

  if (loading) {
    return <div style={{ color: "#475569", fontSize: 11, paddingTop: 20 }}>Loading...</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, overflowY: "auto", paddingTop: 20, flex: 1 }}>
      <div style={{ color: "#64748b", fontSize: 10, letterSpacing: 1, marginBottom: 8 }}>
        {devices.length} DEVICE{devices.length !== 1 ? "S" : ""} KNOWN
      </div>
      {devices.length === 0 && (
        <div style={{ color: "#475569", fontSize: 11, textAlign: "center", marginTop: 20 }}>
          No devices discovered yet
        </div>
      )}
      {devices.map(d => {
        const isIgnored = !!d.ignored;
        const isToggling = !!toggling[d.id];
        const portCount = d.ports ? d.ports.length : 0;
        const lastSeen = d.last_seen
          ? new Date(d.last_seen).toLocaleString()
          : "never";
        return (
          <div
            key={d.id}
            style={{
              ...ROW_BASE,
              backgroundColor: isIgnored ? "#0a0a0a" : "#0a0e18",
              opacity: isIgnored ? 0.55 : 1,
            }}
          >
            {/* Status dot */}
            <div style={{
              width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
              backgroundColor: d.ping_status === "online" ? "#22c55e"
                : d.ping_status === "offline" ? "#ef4444"
                : "#475569",
            }} title={d.ping_status} />

            {/* Device info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: isIgnored ? "#475569" : "#e2e8f0", fontWeight: 600, fontSize: 12 }}>
                  {d.sys_name || d.ip}
                </span>
                {d.sys_name && (
                  <span style={{ color: "#334155", fontSize: 10 }}>{d.ip}</span>
                )}
                {isIgnored && (
                  <span style={{
                    backgroundColor: "#1c0a0a", border: "1px solid #7f1d1d",
                    color: "#f87171", borderRadius: 4, padding: "1px 6px",
                    fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                  }}>
                    IGNORED
                  </span>
                )}
              </div>
              <div style={{ color: "#475569", fontSize: 10, marginTop: 2, display: "flex", gap: 12 }}>
                <span>{portCount} port{portCount !== 1 ? "s" : ""}</span>
                <span>Last seen: {lastSeen}</span>
                {d.vendor && <span>{d.vendor}</span>}
                {d.model && <span>{d.model}</span>}
              </div>
            </div>

            {/* Ignore toggle */}
            <button
              onClick={() => toggleIgnored(d)}
              disabled={isToggling}
              title={isIgnored ? "Remove from ignore list" : "Ignore this device"}
              style={{
                flexShrink: 0,
                backgroundColor: isIgnored ? "#1c0a0a" : "transparent",
                border: `1px solid ${isIgnored ? "#7f1d1d" : "#1e293b"}`,
                color: isIgnored ? "#f87171" : "#64748b",
                borderRadius: 6,
                padding: "4px 10px",
                cursor: isToggling ? "not-allowed" : "pointer",
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 10,
                fontWeight: 600,
                opacity: isToggling ? 0.5 : 1,
              }}
            >
              {isToggling ? "..." : isIgnored ? "Unignore" : "Ignore"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

**Checklist:**
- [ ] Datei `frontend/src/components/settings/DevicesTab.jsx` mit obigem Inhalt erstellen

---

### SCHRITT 10 — Frontend: SettingsPage.jsx — neuen "Devices"-Tab registrieren

**Datei:** `frontend/src/pages/SettingsPage.jsx`

#### 10a) Import hinzufugen (Zeile ~11, nach den bestehenden Imports)

Aktuell (letzter Import vor dem Kommentar):
```jsx
import DataImportExportTabContent from "../components/settings/ImportExportTab.jsx";
```

Neu — Zeile dahinter:
```jsx
import DataImportExportTabContent from "../components/settings/ImportExportTab.jsx";
import DevicesTabContent          from "../components/settings/DevicesTab.jsx";
```

#### 10b) NAV_GROUPS — neuen Eintrag im INFRASTRUCTURE-Block

Aktuell im INFRASTRUCTURE-Block:
```jsx
    {
      group: "INFRASTRUCTURE",
      items: [
        { tab:"switches", label:"Switches",  desc:"Credentials" },
        { tab:"racks",    label:"Racks",     desc:"Rack definitions" },
        { tab:"classes",  label:"Classes",   desc:"Device roles / classes" },
        { tab:"models",   label:"Models",    desc:"Switch models & port layout" },
      ],
    },
```

Neu — "Devices" nach "Switches":
```jsx
    {
      group: "INFRASTRUCTURE",
      items: [
        { tab:"switches", label:"Switches",  desc:"Credentials" },
        { tab:"devices",  label:"Devices",   desc:"Scan behavior per device" },
        { tab:"racks",    label:"Racks",     desc:"Rack definitions" },
        { tab:"classes",  label:"Classes",   desc:"Device roles / classes" },
        { tab:"models",   label:"Models",    desc:"Switch models & port layout" },
      ],
    },
```

#### 10c) Content-Area — neuen Tab-Case hinzufugen

Aktuell:
```jsx
          {activeTab === "switches" && <CredentialsTabContent profiles={profiles} />}
```

Neu — nach dieser Zeile:
```jsx
          {activeTab === "switches" && <CredentialsTabContent profiles={profiles} />}
          {activeTab === "devices"  && <DevicesTabContent />}
```

**Checklist:**
- [ ] `import DevicesTabContent` nach `DataImportExportTabContent` import einfugen
- [ ] `{ tab:"devices", label:"Devices", desc:"Scan behavior per device" }` in INFRASTRUCTURE-Block nach "switches" einfugen
- [ ] `{activeTab === "devices" && <DevicesTabContent />}` in Content-Area nach "switches"-Case einfugen

---

## Reihenfolge der Implementierung

1. **SCHRITT 1** — Alembic-Migration erstellen (Backend, kein laufender Code benotigt)
2. **SCHRITT 2** — `database.py` ORM erganzen (Backend-Restart benotigt)
3. **SCHRITT 3** — `schemas.py` Pydantic-Schemas erganzen
4. **SCHRITT 4** — `topology.py` Endpoints anpassen + neuer GET /api/devices
5. **SCHRITT 5** — `scan_engine.py` Scan-Skip einbauen
6. **SCHRITT 6-8** — Frontend Assign-Dropdown-Filter (Feature 1, unabhangig vom Backend)
7. **SCHRITT 9** — `DevicesTab.jsx` erstellen
8. **SCHRITT 10** — `SettingsPage.jsx` Tab registrieren
9. **Migration ausfuhren** — Docker-Container neu starten, Alembic lauft via `entrypoint.sh` automatisch

---

## Testszenarien

| Szenario | Erwartetes Verhalten |
|----------|---------------------|
| Device ohne Ports im RacksTab-Dropdown | Nicht angezeigt im "Assign"-Dropdown |
| Device mit Ports im RacksTab-Dropdown | Angezeigt im "Assign"-Dropdown |
| Bereits zugewiesenes Device ohne Ports | Bleibt in "Assigned"-Liste sichtbar |
| Device auf ignored=True setzen | Verschwindet aus GET /api/topology (Karte), bleibt in GET /api/devices |
| Ignored Device im Scan | Wird in scan_engine.py uberschlagen (kein SNMP-Scan) |
| Ignored Device in DevicesTab | Ausgegraut, "IGNORED"-Badge, "Unignore"-Button |
| Unignore eines Devices | ping_status, ports erhalten geblieben, taucht wieder in Karte auf |

---

## Wichtige Randnotizen

1. **SQLite ADD COLUMN**: SQLite erlaubt `ADD COLUMN` nur mit `server_default`, nicht mit Constraints wie `CHECK`. Das verwendete `server_default="0"` ist SQLite-kompatibel.

2. **`Device.ignored` im ORM vs. `server_default`**: Die SQLAlchemy-Column hat `default=False` (Python-seitig), die Migration hat `server_default="0"` (DB-seitig). Beide sind notwendig fur konsistentes Verhalten.

3. **`ports` in DeviceOut**: Das `ports`-Feld ist durch `lazy="selectin"` immer geladen wenn ein Device abgerufen wird. Die Frontend-Prufung `d.ports && d.ports.length > 0` ist sicher.

4. **`GET /api/devices` Response-Format**: Zur Konsistenz wird die gleiche JSON-Serialisierung wie in GET /api/topology verwendet (via `model_dump()`). Der Endpunkt gibt eine flache Liste von `DeviceOut`-Objekten zuruck (kein `TopologyOut`-Wrapper).

5. **ETag/Caching**: GET /api/devices benotigt kein ETag — dieser Endpunkt wird nur im Settings-Tab aufgerufen, nicht in der Hot-Reload-Topologie.

6. **Bestehende Ports bei ignored=True**: Ports bleiben in der DB erhalten. Das ist gewunscht — beim Zurucksetzen auf `ignored=False` sind die historischen Port-Daten noch vorhanden.
