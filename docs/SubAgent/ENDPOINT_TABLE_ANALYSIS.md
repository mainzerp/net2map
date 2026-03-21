# Endpoint Table Separation -- Research Analysis

## 1. Current Schema: Device Model

### Table: `devices`

All discovered network entities (managed switches and unmanaged endpoints) share a single table.

| Column        | Type      | Default/Notes                                    |
|---------------|-----------|--------------------------------------------------|
| `id`          | Integer   | PK, indexed                                      |
| `sys_name`    | String    | SNMP sysName, indexed                            |
| `ip`          | String    | NOT NULL, unique, indexed                        |
| `sys_descr`   | Text      | default ""                                       |
| `model`       | String    | default ""                                       |
| `vendor`      | String    | default "" ("aruba_cx", "fs", "generic")         |
| `location`    | String    | sysLocation, default ""                          |
| `ping_status` | String    | "online"/"offline"/"unknown"                     |
| `ping_rtt_ms` | Integer   | default 0                                        |
| `last_ping`   | DateTime  | nullable                                         |
| `map_x`       | Float     | default 100.0                                    |
| `map_y`       | Float     | default 100.0                                    |
| `last_seen`   | DateTime  | default now(utc)                                 |
| `ignored`     | Boolean   | default False                                    |
| `rack_id`     | Integer   | FK -> racks.id, nullable                         |
| `class_id`    | Integer   | FK -> switch_classes.id, nullable                |
| `model_id`    | Integer   | FK -> switch_models.id, nullable                 |
| `label`       | String    | default ""                                       |
| `enabled`     | Boolean   | default True                                     |
| `is_managed`  | Boolean   | default False -- **the differentiator column**   |

### Relationships on Device

| Relationship   | Target Model | FK Column   | Cascade                    |
|----------------|-------------|-------------|----------------------------|
| `ports`        | Port        | device_id   | all, delete-orphan (selectin) |
| `rack`         | Rack        | rack_id     | joined                     |
| `switch_class` | SwitchClass | class_id    | joined                     |
| `switch_model` | SwitchModel | model_id    | joined                     |
| `credentials`  | Credential  | device_id   | selectin                   |

### Table: `ports`

| Column                  | Type    | Notes                                  |
|-------------------------|---------|----------------------------------------|
| `id`                    | Integer | PK                                     |
| `device_id`             | Integer | FK -> devices.id, NOT NULL, indexed    |
| `if_index`              | Integer | NOT NULL                               |
| `if_descr`              | String  | default ""                             |
| `if_alias`              | String  | default ""                             |
| `speed_mbps`            | Integer | default 0                              |
| `oper_status`           | Integer | 1=up, 2=down                           |
| `peer_mac`              | String  | default "" -- primary connected MAC    |
| `peer_ip`               | String  | default "" -- primary connected IP     |
| `peer_host`             | String  | default "" -- resolved hostname        |
| `endpoint_count`        | Integer | default 0                              |
| `endpoint_details_json` | JSONB   | default [] -- [{mac, ip, host}, ...]   |
| `vlan`                  | Integer | default 0                              |
| `tagged_vlans`          | JSONB   | default []                             |

### Table: `credentials`

| Column      | Type    | Notes                                          |
|-------------|---------|------------------------------------------------|
| `device_id` | Integer | FK -> devices.id (ondelete SET NULL), nullable |
| ...         | ...     | SNMP credential fields                         |

### Table: `topology_links`

References devices indirectly by IP (not FK), so no direct FK impact.

---

## 2. How Endpoints vs Network Devices Are Currently Differentiated

### The `is_managed` Column

- **Network devices** (`is_managed=True`): Switches, routers, APs -- devices that have SNMP credentials and are actively scanned. They appear on the topology map.
- **Endpoints** (`is_managed=False`): MAC addresses discovered on switch ports (via ARP/FDB tables) that are resolved to IPs via ping. They do NOT appear on the topology map.

### Where the Differentiation Happens

1. **Scan engine** (`backend/scan_engine/executor.py` lines 500-555):
   - When creating a new Device: `is_managed=cred is not None` -- if a credential exists for the IP, it is a managed device.
   - For existing devices: `device.is_managed = True` is set when a credential is found.

2. **Topology API** (`backend/routers/topology.py` line 97):
   - `Device.is_managed == True` filter: only managed devices appear in topology.

3. **Devices API** (`backend/routers/topology.py` `list_all_devices`):
   - `?role=network` -> `Device.is_managed == True`
   - `?role=endpoint` -> `Device.is_managed == False`

4. **Frontend**:
   - `DevicesPage.tsx`: passes `role="endpoint"` to DeviceTable
   - `NetworkPage.tsx`: passes `role="network"` to DeviceTable

### How Endpoints Are Discovered

Endpoints do NOT get their own Device rows via explicit creation. Instead:

1. The scan engine discovers IPs via ping during range-based discovery
2. If no SNMP credential exists and SNMP scan fails, a Device is created with `is_managed=False`
3. Endpoint details (MAC, IP, hostname) are stored on **Port** records as `peer_mac`, `peer_ip`, `peer_host`, and `endpoint_details_json`
4. The `list_all_devices` endpoint builds a `found_on` lookup by matching `Device.ip` against `Port.peer_ip` to show which switch port an endpoint was found on

**Key insight**: Endpoints exist in TWO places:
- As rows in the `devices` table (with `is_managed=False`) -- created during ping discovery
- As data embedded in `ports.endpoint_details_json` / `ports.peer_*` columns -- from FDB/ARP table walks on managed switches

---

## 3. Data That Is Endpoint-Specific vs Network-Device-Specific

### Used by BOTH endpoints and network devices

| Column       | Endpoints                  | Network Devices           |
|-------------|----------------------------|---------------------------|
| `id`        | Yes                        | Yes                       |
| `ip`        | Yes (discovered IP)        | Yes (management IP)       |
| `sys_name`  | Often just the IP string   | SNMP sysName              |
| `sys_descr` | "Discovered by ping"       | SNMP sysDescr             |
| `ping_status` | Yes                      | Yes                       |
| `ping_rtt_ms` | Yes                      | Yes                       |
| `last_ping` | Yes                        | Yes                       |
| `map_x/y`   | Not used visually          | Used for map position     |
| `last_seen` | Yes                        | Yes                       |
| `ignored`   | Yes                        | Yes                       |
| `label`     | Often empty                | From credential label     |
| `enabled`   | Default true               | From credential           |

### Only meaningful for NETWORK DEVICES

| Column     | Why                                              |
|-----------|--------------------------------------------------|
| `vendor`  | SNMP vendor classification (aruba_cx, fs, etc.)  |
| `model`   | Extracted from sysDescr                          |
| `location`| SNMP sysLocation                                 |
| `rack_id` | FK to racks -- rack assignment                   |
| `class_id`| FK to switch_classes -- device classification    |
| `model_id`| FK to switch_models -- hardware model            |
| `ports`   | Physical switch ports (Port relationship)        |
| `credentials` | SNMP credentials                             |
| `is_managed` | Always True for network devices               |

### Only meaningful for ENDPOINTS

| Column/Data     | Where It Lives                           |
|-----------------|------------------------------------------|
| `found_on`      | Computed at query time from Port.peer_ip |
| MAC address     | On Port.peer_mac / endpoint_details_json |
| DNS hostname    | On Port.peer_host / endpoint_details_json|
| Switch port     | Port record on the managed device        |

---

## 4. Alembic Migrations Inventory

| File | Description |
|---|---|
| `001_initial_schema.py` | Initial tables |
| `002_add_device_ignored.py` | Added `ignored` column to devices |
| `003_add_cascade_deletes.py` | Add cascade delete behavior |
| `003b_add_switch_class_allow_outside_rack.py` | SwitchClass `allow_outside_rack` |
| `004_jsonb_snapshot_columns.py` | JSONB columns for scan snapshots |
| `005_settings_to_db.py` | Move settings to AppSetting table |
| `006_add_users_table.py` | Users table |
| `007_add_audit_log.py` | Audit log table |
| `008_credential_fallback.py` | Credential fallback chain |
| `009_dry_run_results.py` | DryRunResult table |
| `010_dry_run_cascade.py` | Cascade on dry run FK |
| `011_add_tagged_vlans.py` | JSONB tagged_vlans on ports |
| `012_consolidate_credential_device.py` | **Latest** -- moved metadata from Credential to Device, added `label`, `enabled`, `is_managed` to Device, added `device_id` FK to Credential |

The next migration will be `013`.

---

## 5. Foreign Key Relationships Affected

### FKs that reference `devices.id`

| Source Table   | Column      | On Delete   | Impact                          |
|---------------|-------------|-------------|----------------------------------|
| `ports`       | `device_id` | CASCADE (ORM) | Ports belong to managed devices only; endpoints would have no ports |
| `credentials` | `device_id` | SET NULL    | Credentials link to managed devices only; endpoints should not have credentials |

### FKs on `devices` table itself

| Column     | References        | Impact                                       |
|-----------|-------------------|----------------------------------------------|
| `rack_id` | `racks.id`        | Only relevant for managed devices            |
| `class_id`| `switch_classes.id`| Only relevant for managed devices            |
| `model_id`| `switch_models.id` | Only relevant for managed devices            |

### Reverse relationships (models that have `devices` relationship)

| Model       | Relationship | Impact                                    |
|-------------|-------------|-------------------------------------------|
| `Rack`      | `devices`   | Would only reference managed Device table |
| `SwitchClass`| `devices`  | Would only reference managed Device table |
| `SwitchModel`| `devices`  | Would only reference managed Device table |

---

## 6. Complete File Inventory -- Files That Need Changes

### Backend -- Database & Models

| File | What References Device | Changes Needed |
|---|---|---|
| [backend/database.py](backend/database.py) | `Device` model definition, `Port`, `Credential` FKs, `Rack`/`SwitchClass`/`SwitchModel` relationships | Create new `Endpoint` model; modify `Device` to remove endpoint-related logic; update relationships |
| [backend/schemas.py](backend/schemas.py) | `DeviceBase`, `DeviceOut`, `DeviceMetaUpdate`, `BulkDeviceMetaUpdate`, `DevicePositionUpdate`, `FoundOnPort` | Create `EndpointOut` schema; possibly simplify `DeviceOut` |

### Backend -- Alembic

| File | Changes Needed |
|---|---|
| `backend/alembic/versions/013_*.py` | New migration: create `endpoints` table, migrate `is_managed=False` devices, update FKs |

### Backend -- Routers

| File | What References Device | Changes Needed |
|---|---|---|
| [backend/routers/topology.py](backend/routers/topology.py) | `GET /api/topology` (filters `is_managed=True`), `GET /api/devices` (role filter), position/meta updates, bulk meta | Split `/api/devices` into `/api/devices` (network only) and `/api/endpoints`; remove `is_managed` filter from topology (all devices are managed); update `list_all_devices` |
| [backend/routers/credentials.py](backend/routers/credentials.py) | Auto-links credential to Device by IP | No major change -- credentials are only for managed devices |
| [backend/routers/bulk.py](backend/routers/bulk.py) | References `device_id` in credential export/import | Minimal change -- device_id stays on managed devices |
| [backend/routers/config.py](backend/routers/config.py) | References `device_id` in config export/import | Same as bulk.py |
| [backend/routers/scan.py](backend/routers/scan.py) | Triggers scan engine | No direct Device reference, but scan engine changes affect results |
| [backend/routers/scan_runs.py](backend/routers/scan_runs.py) | References `ScanRun`, `DryRunResult` | Minimal -- snapshots use IP strings not device IDs |
| [backend/routers/racks.py](backend/routers/racks.py) | `Device.rack_id` nullification on rack delete | Only affects managed devices (correct after split) |
| [backend/routers/switch_classes.py](backend/routers/switch_classes.py) | `Device.class_id` nullification on class delete | Only affects managed devices (correct after split) |
| [backend/routers/switch_models.py](backend/routers/switch_models.py) | `Device.model_id` nullification on model delete | Only affects managed devices (correct after split) |
| [backend/routers/settings.py](backend/routers/settings.py) | `Device` count in `/api/stats` | Update to count devices + endpoints separately |

### Backend -- Scan Engine

| File | What References Device | Changes Needed |
|---|---|---|
| [backend/scan_engine/executor.py](backend/scan_engine/executor.py) | Creates/updates Device records for both managed and unmanaged; endpoint details stored on Port records; `is_managed` flag set based on credential existence | Major changes: create endpoints in new table instead of Device; update port endpoint data to reference Endpoint table; decouple endpoint discovery from Device creation |
| [backend/scan_engine/db_helpers.py](backend/scan_engine/db_helpers.py) | `_persist_scan_run` -- stores device IPs in snapshot | May need to distinguish device vs endpoint IPs in snapshots |
| [backend/scan_engine/jobs.py](backend/scan_engine/jobs.py) | Calls `_execute_scan` | No direct changes needed |

### Backend -- Seed & Migration

| File | Changes Needed |
|---|---|
| [backend/seed_db.py](backend/seed_db.py) | Currently creates Device records with `is_managed=True` and ports with `peer_mac`/`peer_ip`. May need to seed endpoint records in new table |

### Backend -- Shared

| File | Changes Needed |
|---|---|
| [backend/shared/metrics.py](backend/shared/metrics.py) | `DEVICE_COUNT` metric -- may want separate endpoint metric |

### Backend -- Tests

| File | What References Device | Changes Needed |
|---|---|---|
| [backend/tests/test_topology.py](backend/tests/test_topology.py) | Creates `Device(is_managed=True/False)` instances, tests topology inclusion/exclusion | Update tests: managed devices in Device table, endpoints in Endpoint table |
| [backend/tests/test_cascade.py](backend/tests/test_cascade.py) | Tests Device cascade deletes (ports, credentials) | Add endpoint cascade tests |
| [backend/tests/conftest.py](backend/tests/conftest.py) | Sets up test DB with all models | Ensure Endpoint model is included |
| [backend/tests/test_credentials.py](backend/tests/test_credentials.py) | Tests credential CRUD with device_id | Minimal changes |
| [backend/tests/test_scan_jobs.py](backend/tests/test_scan_jobs.py) | Scan job tests | May need updates if scan result structure changes |
| [backend/tests/test_scanners.py](backend/tests/test_scanners.py) | Scanner tests | Likely no changes |

### Frontend -- Pages & Components

| File | What References Devices | Changes Needed |
|---|---|---|
| [frontend/src/pages/DevicesPage.tsx](frontend/src/pages/DevicesPage.tsx) | Renders `DeviceTable` with `role="endpoint"` | Update to call `/api/endpoints` instead of `/api/devices?role=endpoint` |
| [frontend/src/pages/NetworkPage.tsx](frontend/src/pages/NetworkPage.tsx) | Renders `DeviceTable` with `role="network"` | Update to call `/api/devices` (which now only returns managed devices) |
| [frontend/src/components/DeviceTable.tsx](frontend/src/components/DeviceTable.tsx) | Fetches `/api/devices?role=${role}`, renders device/endpoint table, edit modal | Needs role-based API path: `role=network` -> `/api/devices`, `role=endpoint` -> `/api/endpoints`; invalidation paths need updating |
| [frontend/src/types.ts](frontend/src/types.ts) | `TopologyNode`, `DeviceTableProps`, `EndpointDetail`, `FoundOnPort` | May need new `Endpoint` TypeScript interface |
| [frontend/src/store.ts](frontend/src/store.ts) | `topology.nodes` filter for rack devices | Minimal -- topology only has managed devices |

### Frontend -- Settings Tabs

| File | What References /api/devices | Changes Needed |
|---|---|---|
| [frontend/src/components/settings/CredentialsTab.tsx](frontend/src/components/settings/CredentialsTab.tsx) | Fetches `/api/devices` for device-credential linking, toggles ignored, invalidates | Update to `/api/devices` (now managed only) -- behavior stays same |
| [frontend/src/components/settings/RacksTab.tsx](frontend/src/components/settings/RacksTab.tsx) | Fetches `/api/devices?role=network` for rack device counts | No change needed (already filters network) |
| [frontend/src/components/settings/SwitchModelsTab.tsx](frontend/src/components/settings/SwitchModelsTab.tsx) | Fetches `/api/devices?role=network` for model assignment counts | No change needed |
| [frontend/src/components/settings/SwitchClassesTab.tsx](frontend/src/components/settings/SwitchClassesTab.tsx) | Fetches `/api/devices?role=network` for class assignment counts | No change needed |

### Frontend -- Tests

| File | Changes Needed |
|---|---|
| [frontend/src/__tests__/DeviceTable.test.tsx](frontend/src/__tests__/DeviceTable.test.tsx) | Mocks `/api/devices` responses -- update mock paths/data |

---

## 7. Summary of Current Architecture

### Data Flow for Endpoint Discovery

```
1. Scan engine runs range-based discovery
2. For each IP in range:
   a. Ping check -> if alive:
   b. Try SNMP with profiles -> if SNMP succeeds:
      -> Create Device(is_managed=True) + auto-create Credential
   c. If SNMP fails but ping succeeds:
      -> Create Device(is_managed=False, sys_descr="Discovered by ping")
3. For managed devices:
   a. Walk FDB/ARP tables -> get MAC->ifIndex + MAC->IP mappings
   b. Store as Port records with peer_mac/peer_ip/peer_host + endpoint_details_json
4. /api/devices?role=endpoint fetches Device(is_managed=False)
5. found_on computed at query time by matching Device.ip against Port.peer_ip
```

### Key Observations

1. **Endpoints have minimal data**: IP, ping status, sys_name (usually just IP), and `is_managed=False`. Most useful endpoint data (MAC, hostname, which port they are on) lives on Port records.

2. **Endpoint Device records are created during range-based discovery ping sweep**, NOT from FDB/ARP table walks. The FDB/ARP data goes into Port.endpoint_details_json.

3. **The `found_on` lookup** in `list_all_devices` joins Device.ip against Port.peer_ip to show where an endpoint was seen. This is a critical query pattern.

4. **Port.endpoint_details_json** contains the richest endpoint data -- multiple MACs/IPs per port, with hostnames. This data is NOT in the Device table at all.

5. **No endpoint-specific columns exist on Device** -- the endpoint rows just use fewer of the shared columns, with most network-device-specific columns (vendor, model, location, rack_id, class_id, model_id) left at defaults.

6. **The `devices` table has a unique constraint on `ip`**, which means an IP cannot appear as both a managed device and an endpoint simultaneously.
