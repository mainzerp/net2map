# Endpoint Table Separation -- Implementation Plan

## Overview

Separate endpoints (discovered MAC/IP on switch ports) from network devices (switches, routers, APs) by creating a dedicated `endpoints` table and `endpoint_port_associations` join table. Remove `is_managed` from the `devices` table -- all remaining rows are managed network devices. Update backend routers, scan engine, schemas, frontend pages, and tests.

---

## Phase 1: Database (Migration + Models)

### 1.1 Create Alembic migration `013_separate_endpoints`

- [ ] **File**: `backend/alembic/versions/013_separate_endpoints.py`
- Revision `013`, down_revision `012`

#### 1.1.1 Create `endpoints` table

```sql
CREATE TABLE endpoints (
    id          SERIAL PRIMARY KEY,
    mac         VARCHAR NOT NULL UNIQUE,
    ip          VARCHAR,
    hostname    VARCHAR,
    first_seen  TIMESTAMP DEFAULT now(),
    last_seen   TIMESTAMP DEFAULT now(),
    ignored     BOOLEAN DEFAULT false NOT NULL,
    notes       TEXT
);
CREATE INDEX ix_endpoints_mac ON endpoints (mac);
CREATE INDEX ix_endpoints_ip ON endpoints (ip);
```

Columns:
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | Integer | PK, autoincrement |
| `mac` | String | NOT NULL, UNIQUE, indexed |
| `ip` | String | nullable, indexed |
| `hostname` | String | nullable |
| `first_seen` | DateTime | server_default=now() |
| `last_seen` | DateTime | server_default=now() |
| `ignored` | Boolean | default False, NOT NULL |
| `notes` | Text | nullable |

#### 1.1.2 Create `endpoint_port_associations` table

```sql
CREATE TABLE endpoint_port_associations (
    id          SERIAL PRIMARY KEY,
    endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    port_id     INTEGER NOT NULL REFERENCES ports(id) ON DELETE CASCADE,
    vlan_id     INTEGER,
    last_seen   TIMESTAMP DEFAULT now()
);
CREATE INDEX ix_epa_endpoint_id ON endpoint_port_associations (endpoint_id);
CREATE INDEX ix_epa_port_id ON endpoint_port_associations (port_id);
CREATE UNIQUE INDEX uq_epa_endpoint_port ON endpoint_port_associations (endpoint_id, port_id);
```

Columns:
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | Integer | PK, autoincrement |
| `endpoint_id` | Integer | FK -> endpoints.id, ON DELETE CASCADE, NOT NULL |
| `port_id` | Integer | FK -> ports.id, ON DELETE CASCADE, NOT NULL |
| `vlan_id` | Integer | nullable |
| `last_seen` | DateTime | server_default=now() |

Unique constraint on `(endpoint_id, port_id)` to prevent duplicate associations.

#### 1.1.3 Data migration: `devices` (is_managed=False) -> `endpoints`

For each Device row where `is_managed = False`:
1. Look up all Port records where `peer_ip = device.ip` OR where the device IP appears in `endpoint_details_json`
2. Extract the MAC address from the matching port's `peer_mac` field
3. Insert into `endpoints` with:
   - `mac` = the discovered peer_mac (or generate a placeholder like `unknown-{device.ip}` if no MAC found)
   - `ip` = device.ip
   - `hostname` = device.sys_name (if it differs from device.ip, else NULL)
   - `first_seen` = device.last_seen (best available)
   - `last_seen` = device.last_seen
   - `ignored` = device.ignored
4. For each matching Port, insert a row in `endpoint_port_associations`:
   - `endpoint_id` = new endpoint.id
   - `port_id` = matching port.id
   - `vlan_id` = port.vlan (if non-zero, else NULL)
   - `last_seen` = device.last_seen

#### 1.1.4 Data migration: `ports.endpoint_details_json` -> `endpoints` + `endpoint_port_associations`

For each Port that has non-empty `endpoint_details_json`:
1. Iterate each entry `{mac, ip, host}` in the JSON array
2. If an endpoint with that MAC already exists (from step 1.1.3), update its `ip`/`hostname` if richer data is available
3. If no endpoint with that MAC exists, INSERT into `endpoints`:
   - `mac` = entry.mac
   - `ip` = entry.ip
   - `hostname` = entry.host
   - `first_seen` = now()
   - `last_seen` = now()
4. UPSERT into `endpoint_port_associations`:
   - `endpoint_id` = endpoint.id (matched or newly created)
   - `port_id` = port.id
   - `vlan_id` = port.vlan (if non-zero, else NULL)
   - `last_seen` = now()

#### 1.1.5 Delete migrated rows from `devices`

```sql
DELETE FROM devices WHERE is_managed = false;
```

Note: Ports belong to managed devices only (they have `device_id` FK). Unmanaged device rows had no ports of their own -- they were just placeholders. The CASCADE on `devices.ports` will not affect managed device ports because we only delete `is_managed=False` rows.

#### 1.1.6 Remove `is_managed` column from `devices`

```sql
ALTER TABLE devices DROP COLUMN is_managed;
```

After this, all remaining `devices` rows are network devices.

#### 1.1.7 Remove endpoint columns from `ports`

Drop these columns since their data now lives in `endpoints` + `endpoint_port_associations`:
- `peer_mac`
- `peer_ip`
- `peer_host`
- `endpoint_count`
- `endpoint_details_json`

```sql
ALTER TABLE ports DROP COLUMN peer_mac;
ALTER TABLE ports DROP COLUMN peer_ip;
ALTER TABLE ports DROP COLUMN peer_host;
ALTER TABLE ports DROP COLUMN endpoint_count;
ALTER TABLE ports DROP COLUMN endpoint_details_json;
```

#### 1.1.8 Downgrade function

Reverse: re-add columns, re-create Device rows from endpoints, restore `is_managed`. (Best-effort; data loss for endpoint_port_associations detail is acceptable on downgrade.)

---

### 1.2 Update SQLAlchemy models in `database.py`

- [ ] **File**: `backend/database.py`

#### 1.2.1 Add `Endpoint` model

```python
class Endpoint(Base):
    """Discovered endpoint device (MAC/IP found on a switch port)."""
    __tablename__ = "endpoints"

    id         = Column(Integer, primary_key=True, index=True)
    mac        = Column(String, nullable=False, unique=True, index=True)
    ip         = Column(String, nullable=True, index=True)
    hostname   = Column(String, nullable=True)
    first_seen = Column(DateTime, server_default=func.now())
    last_seen  = Column(DateTime, server_default=func.now())
    ignored    = Column(Boolean, default=False, nullable=False)
    notes      = Column(Text, nullable=True)

    port_associations = relationship(
        "EndpointPortAssociation", back_populates="endpoint",
        cascade="all, delete-orphan", lazy="selectin",
    )
```

#### 1.2.2 Add `EndpointPortAssociation` model

```python
class EndpointPortAssociation(Base):
    """Many-to-many link between endpoints and ports."""
    __tablename__ = "endpoint_port_associations"
    __table_args__ = (
        UniqueConstraint("endpoint_id", "port_id", name="uq_epa_endpoint_port"),
    )

    id          = Column(Integer, primary_key=True, index=True)
    endpoint_id = Column(Integer, ForeignKey("endpoints.id", ondelete="CASCADE"), nullable=False, index=True)
    port_id     = Column(Integer, ForeignKey("ports.id", ondelete="CASCADE"), nullable=False, index=True)
    vlan_id     = Column(Integer, nullable=True)
    last_seen   = Column(DateTime, server_default=func.now())

    endpoint = relationship("Endpoint", back_populates="port_associations")
    port     = relationship("Port", back_populates="endpoint_associations")
```

#### 1.2.3 Update `Device` model

- Remove `is_managed` column
- No other column changes needed (label, enabled remain)

#### 1.2.4 Update `Port` model

- Remove columns: `peer_mac`, `peer_ip`, `peer_host`, `endpoint_count`, `endpoint_details_json`
- Add relationship:
  ```python
  endpoint_associations = relationship(
      "EndpointPortAssociation", back_populates="port",
      cascade="all, delete-orphan", lazy="selectin",
  )
  ```

---

## Phase 2: Backend (Routers, Scan Engine, Schemas)

### 2.1 Add endpoint Pydantic schemas

- [ ] **File**: `backend/schemas.py`

#### 2.1.1 Add `EndpointPortInfo` schema

```python
class EndpointPortInfo(BaseModel):
    """Port where an endpoint was seen."""
    port_id: int
    switch_ip: str = ""
    switch_name: str = ""
    port_name: str = ""
    vlan_id: Optional[int] = None
    last_seen: Optional[datetime] = None

    class Config:
        from_attributes = True
```

#### 2.1.2 Add `EndpointOut` schema

```python
class EndpointOut(BaseModel):
    id: int
    mac: str
    ip: Optional[str] = None
    hostname: Optional[str] = None
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    ignored: bool = False
    notes: Optional[str] = None
    found_on: List[EndpointPortInfo] = []

    class Config:
        from_attributes = True
```

#### 2.1.3 Add `EndpointUpdate` schema

```python
class EndpointUpdate(BaseModel):
    ignored: Optional[bool] = None
    notes: Optional[str] = None
```

#### 2.1.4 Add `BulkEndpointUpdate` schema

```python
class BulkEndpointUpdate(BaseModel):
    endpoint_ids: List[int]
    ignored: Optional[bool] = None
```

#### 2.1.5 Update `PortOut` schema

- Remove fields: `peer_mac`, `peer_ip`, `peer_host`, `endpoint_count`, `endpoint_details_json`
- Add field: `endpoint_count: int = 0` (computed from endpoint_associations length)
- Remove the corresponding entries from `_coerce_nulls` defaults dict

#### 2.1.6 Update `DeviceBase` / `DeviceOut` schemas

- Remove `is_managed` field from `DeviceBase`
- Remove `found_on` field from `DeviceOut` (endpoints have their own `found_on` via `EndpointPortInfo`)
- Remove import of `FoundOnPort` from topology router imports

#### 2.1.7 Remove `FoundOnPort` schema

No longer needed -- replaced by `EndpointPortInfo`.

---

### 2.2 Create `/api/endpoints` router

- [ ] **File**: `backend/routers/endpoints.py` (NEW)

#### 2.2.1 `GET /api/endpoints` -- List all endpoints

- Query `Endpoint` table, eager-load `port_associations` and their `port` -> `device` relationships
- Build `EndpointOut` list with `found_on` populated from `EndpointPortAssociation` -> `Port` -> `Device`
- Support ETag caching (sha256 hash of body)
- Return JSON array of `EndpointOut`

#### 2.2.2 `GET /api/endpoints/{endpoint_id}` -- Get single endpoint

- Return `EndpointOut` with full `found_on` information

#### 2.2.3 `PATCH /api/endpoints/{endpoint_id}` -- Update endpoint

- Accept `EndpointUpdate` body (ignored, notes)
- Requires `admin` or `operator` role
- Audit log the change

#### 2.2.4 `PATCH /api/endpoints/bulk` -- Bulk update endpoints

- Accept `BulkEndpointUpdate` body
- Requires `admin` or `operator` role
- Audit log the change

#### 2.2.5 `DELETE /api/endpoints/{endpoint_id}` -- Delete endpoint

- Requires `admin` role
- CASCADE deletes `endpoint_port_associations`
- Audit log the deletion

---

### 2.3 Update topology router

- [ ] **File**: `backend/routers/topology.py`

#### 2.3.1 Update `get_topology()` (line ~97)

- Remove `Device.is_managed == True` filter -- all devices in the table are now network devices
- Keep `Device.ignored == False` filter

#### 2.3.2 Update `list_all_devices()` (GET /api/devices)

- Remove `role` query parameter entirely
- Remove `is_managed` filter logic
- Remove `found_on` / `FoundOnPort` computation (endpoints are served from `/api/endpoints` now)
- All devices returned are network devices
- Keep ETag caching

#### 2.3.3 Update imports

- Remove `FoundOnPort` from schema imports
- Remove references to `Device.is_managed`

---

### 2.4 Update scan engine

- [ ] **File**: `backend/scan_engine/executor.py`

#### 2.4.1 Update device creation/update block (~lines 500-555)

Current logic: if no credential exists and ping succeeds, create a `Device(is_managed=False)`.

New logic:
- If credential exists (SNMP succeeds): create/update a `Device` row (no `is_managed` field needed)
- If no credential exists (ping-only discovery): do NOT create a Device row. Instead, skip -- endpoints will be created from FDB/ARP data in the port update phase (step 2.4.2)
- For existing Device rows that would have been `is_managed=False` in the old logic: this is handled by the migration. Going forward, the scan engine no longer creates Device rows for ping-only discoveries.

Specific changes:
- Remove `is_managed=cred is not None` from `Device()` constructor
- Remove `device.is_managed = True` assignment
- Skip `Device` creation entirely when `cred is None` and `sw is None` (ping-only discovery) -- these IPs should not become Device rows
- Keep Device creation when `sw is not None` (SNMP scan succeeded) regardless of credential existence (auto-credential handles this)

#### 2.4.2 Update port/endpoint update block (~lines 600-650)

Current logic: stores endpoint data as `peer_mac`, `peer_ip`, `peer_host`, `endpoint_details_json` on Port rows.

New logic -- after ports are created/updated:
1. For each port with endpoint entries (from `peers_by_ifindex`):
   - For each `(mac, ip, host)` tuple:
     a. UPSERT into `endpoints` table: match on `mac`, update `ip`/`hostname`/`last_seen`
     b. UPSERT into `endpoint_port_associations`: match on `(endpoint_id, port_id)`, update `vlan_id`/`last_seen`
2. Remove the `peer_mac`, `peer_ip`, `peer_host`, `endpoint_count`, `endpoint_details_json` assignments from port row dicts
3. Import `Endpoint` and `EndpointPortAssociation` models

#### 2.4.3 Handle stale endpoint associations

After port update for a device:
- Delete `endpoint_port_associations` rows that reference ports on this device but were NOT seen in the current scan (stale associations)
- Do NOT delete the `Endpoint` row itself -- it may appear on other switch ports, and the `last_seen` timestamp tells us when it was last active

---

### 2.5 Update settings router

- [ ] **File**: `backend/routers/settings.py`

#### 2.5.1 Update `get_stats()` endpoint

- Add `endpoint_count` to stats response (query `Endpoint` table count)
- Rename existing `device_count` to be explicit: it now counts only network devices
- Import `Endpoint` model from database

---

### 2.6 Update db_helpers

- [ ] **File**: `backend/scan_engine/db_helpers.py`

- In `_persist_scan_run`, the `devices_snapshot_json` stores device IPs. Since ping-only IPs no longer become Device rows, the snapshot continues to capture only scanned (managed) device IPs -- no changes needed unless the snapshot should also track endpoint count. Add `endpoint_count` to the snapshot if desired (optional).

---

### 2.7 Update metrics

- [ ] **File**: `backend/shared/metrics.py`

- Add `ENDPOINT_COUNT = Gauge("netmap_endpoints_total", "Total discovered endpoints")`
- Existing `DEVICE_COUNT` now counts only network devices (accurate after migration)

---

### 2.8 Register endpoints router

- [ ] **File**: `backend/main.py`

- Import `endpoints` router: `from routers.endpoints import router as endpoints_router`
- Register: `app.include_router(endpoints_router)`

---

### 2.9 Update seed_db

- [ ] **File**: `backend/seed_db.py`

- If seed data creates devices with `is_managed=True`: remove the `is_managed` kwarg (column no longer exists)
- If seed data creates devices with `is_managed=False`: replace with `Endpoint` creation + `EndpointPortAssociation` creation
- Update Port seed data to remove `peer_mac`, `peer_ip`, `peer_host`, `endpoint_details_json` columns

---

### 2.10 Update bulk/config routers

- [ ] **File**: `backend/routers/bulk.py`
- [ ] **File**: `backend/routers/config.py`

- If these reference `is_managed` in export/import logic, remove those references
- Config export/import should handle Device records only (all are network devices now)
- If endpoint export/import is desired, add it as a separate block using the `Endpoint` model (optional, can be deferred)

---

## Phase 3: Frontend (Pages, Components, Types, API)

### 3.1 Update TypeScript types

- [ ] **File**: `frontend/src/types.ts`

#### 3.1.1 Add `Endpoint` interface

```typescript
export interface Endpoint {
  id: number;
  mac: string;
  ip: string | null;
  hostname: string | null;
  first_seen: string | null;
  last_seen: string | null;
  ignored: boolean;
  notes: string | null;
  found_on: EndpointPortInfo[];
}

export interface EndpointPortInfo {
  port_id: number;
  switch_ip: string;
  switch_name: string;
  port_name: string;
  vlan_id: number | null;
  last_seen: string | null;
}
```

#### 3.1.2 Update `TopologyNode`

- Remove `is_managed` field

#### 3.1.3 Update `DeviceTableProps`

- Change `role` type to just `"network"` (no longer supports `"endpoint"`)
- OR remove `role` entirely since DeviceTable now only handles network devices

#### 3.1.4 Update `PortInfo`

- Remove `peer_ip`, `peer_mac`, `peer_host`, `endpoint_details_json`, `endpoint_count` fields
- Add `endpoint_count: number` (computed on backend from associations)

---

### 3.2 Update DeviceTable component (network only)

- [ ] **File**: `frontend/src/components/DeviceTable.tsx`

#### 3.2.1 Simplify to network-only

- Remove `role` prop dependency for API path -- always fetch `/api/devices`
- Remove endpoint-specific column definitions and rendering
- Remove `found_on` display code (endpoints have their own page now)
- Remove `role === "endpoint"` conditional branches
- Update `invalidateAll()` to invalidate `/api/topology`, `/api/devices` (remove endpoint paths)
- Remove `role` from `DeviceTableProps` usage or make it optional/unused

---

### 3.3 Create EndpointTable component

- [ ] **File**: `frontend/src/components/EndpointTable.tsx` (NEW)

#### 3.3.1 Endpoint-specific table

- Fetch from `GET /api/endpoints`
- Columns: MAC, IP, Hostname, First Seen, Last Seen, Found On (switch:port), Ignored, Notes
- "Found On" column: show `switch_name (switch_ip) / port_name` from `found_on` array
- Support toggling `ignored` via `PATCH /api/endpoints/{id}`
- Support bulk ignore via `PATCH /api/endpoints/bulk`
- Search/filter on MAC, IP, hostname
- Sorting support
- ETag-based cache invalidation: invalidate `/api/endpoints` paths
- Clicking on "Found On" switch navigates to the network device / highlights port (reuse existing `setHighlightPortKey` from store)

---

### 3.4 Update DevicesPage

- [ ] **File**: `frontend/src/pages/DevicesPage.tsx`

- Replace `<DeviceTable role="endpoint" ...>` with `<EndpointTable />`
- Import `EndpointTable` instead of `DeviceTable`
- Update title/subtitle props or embed them in `EndpointTable`

---

### 3.5 Update NetworkPage

- [ ] **File**: `frontend/src/pages/NetworkPage.tsx`

- Remove `role="network"` prop from `DeviceTable` (or keep as default/ignored)
- Update DeviceTable import if props changed

---

### 3.6 Update settings tabs (minimal changes)

- [ ] **File**: `frontend/src/components/settings/CredentialsTab.tsx`

- Fetch from `/api/devices` (unchanged -- now returns only network devices, which is correct behavior)
- No `role` filter needed

- [ ] **File**: `frontend/src/components/settings/RacksTab.tsx`
- [ ] **File**: `frontend/src/components/settings/SwitchModelsTab.tsx`
- [ ] **File**: `frontend/src/components/settings/SwitchClassesTab.tsx`

- These fetch `/api/devices?role=network`. Update to `/api/devices` (no role param). The response is identical since all devices are now network devices.

---

### 3.7 Update store.ts

- [ ] **File**: `frontend/src/store.ts`

- If `loadTopology` or topology node processing references `is_managed`, remove it
- No major changes expected -- topology already only loads managed devices

---

### 3.8 Update DeviceTable tests

- [ ] **File**: `frontend/src/__tests__/DeviceTable.test.tsx`

- Update mock API paths: remove `?role=` params, always mock `/api/devices`
- Remove endpoint-related test cases (they move to EndpointTable tests)
- Update `DeviceTable` props: remove `role` or set to default

---

### 3.9 Add EndpointTable tests

- [ ] **File**: `frontend/src/__tests__/EndpointTable.test.tsx` (NEW)

- Mock `/api/endpoints` response with `Endpoint[]` data
- Test rendering: MAC, IP, hostname, found_on display
- Test ignore toggle calls `PATCH /api/endpoints/{id}`
- Test empty state message
- Test search/filter

---

## Phase 4: Tests

### 4.1 Update backend test conftest

- [ ] **File**: `backend/tests/conftest.py`

- Ensure `Endpoint` and `EndpointPortAssociation` models are imported and registered with the test DB
- Add fixture(s) for creating test endpoints if needed

### 4.2 Update test_topology.py

- [ ] **File**: `backend/tests/test_topology.py`

- Remove `is_managed=True/False` from `Device()` construction in test fixtures
- Remove tests that check `is_managed` filter behavior on `/api/topology`
- Remove `?role=endpoint` and `?role=network` param tests on `/api/devices`
- Verify `/api/devices` returns all devices (all are network)
- Verify `/api/topology` returns all non-ignored devices

### 4.3 Add test_endpoints.py

- [ ] **File**: `backend/tests/test_endpoints.py` (NEW)

- Test `GET /api/endpoints` returns endpoint list
- Test `GET /api/endpoints/{id}` returns single endpoint with `found_on`
- Test `PATCH /api/endpoints/{id}` toggles ignored
- Test `PATCH /api/endpoints/bulk` bulk ignore
- Test `DELETE /api/endpoints/{id}` removes endpoint and associations
- Test endpoint creation during scan (create Endpoint + EndpointPortAssociation, verify data)
- Test cascade: deleting a port cascades to endpoint_port_associations but not endpoints

### 4.4 Update test_cascade.py

- [ ] **File**: `backend/tests/test_cascade.py`

- Add test: deleting a Device cascades ports -> cascades endpoint_port_associations
- Add test: deleting an Endpoint cascades endpoint_port_associations
- Remove tests referencing `is_managed`

### 4.5 Update test_scan_jobs.py

- [ ] **File**: `backend/tests/test_scan_jobs.py`

- If scan tests create Device objects with `is_managed`, remove that kwarg
- Update assertions to verify endpoints are created in the `endpoints` table (not as `Device(is_managed=False)`)

### 4.6 Update test_settings.py

- [ ] **File**: `backend/tests/test_settings.py`

- Update `GET /api/stats` test to verify `endpoint_count` field is present

### 4.7 Update test_schemas.py

- [ ] **File**: `backend/tests/test_schemas.py`

- Remove `is_managed` from DeviceBase/DeviceOut test data
- Add tests for `EndpointOut`, `EndpointPortInfo`, `EndpointUpdate` schemas

---

## Phase 5: Cleanup

### 5.1 Update VERSION.md

- [ ] **File**: `VERSION.md`

- Add new version entry `v1.16.0 -- Endpoint Table Separation`
- Type: MINOR (new feature, backward-compatible data migration)
- Document:
  - New `endpoints` table and `/api/endpoints` router
  - New `endpoint_port_associations` table
  - Migration 013 details
  - Removed `is_managed` from devices
  - Frontend: DevicesPage now uses EndpointTable
  - List all files modified

### 5.2 Update todo.md

- [ ] **File**: `todo.md`

- Mark endpoint table separation as completed (if listed)
- Add to Completed section

### 5.3 Update seed_db.py (if not done in Phase 2)

- [ ] **File**: `backend/seed_db.py`

- Ensure seed script creates valid data for the new schema

---

## Execution Order

1. Phase 1.2 first -- update SQLAlchemy models (Endpoint, EndpointPortAssociation, remove is_managed from Device, update Port)
2. Phase 1.1 -- create migration 013
3. Phase 2.1 -- add Pydantic schemas
4. Phase 2.2 -- create endpoints router
5. Phase 2.3 -- update topology router
6. Phase 2.4 -- update scan engine
7. Phase 2.5-2.10 -- update remaining backend files
8. Phase 3 -- frontend changes
9. Phase 4 -- tests
10. Phase 5 -- cleanup

---

## Risk Notes

- **Data migration**: Migration 013 should be tested against a copy of production data before applying. Endpoints with no discoverable MAC (ping-only, no FDB match) get a placeholder `unknown-{ip}` MAC.
- **Scan engine**: The change to stop creating Device rows for ping-only discoveries means those IPs will only appear as endpoints if they are later seen on a switch port via FDB/ARP. If a user wants to see all ping-alive IPs, consider adding them as endpoints with a generated MAC.
- **Rollback**: The downgrade path in migration 013 should be implemented but accepted as lossy (endpoint_port_associations detail may not round-trip perfectly).
- **Frontend**: The `EndpointTable` component is new and must handle the different data shape (MAC-based identity vs IP-based identity for devices).
