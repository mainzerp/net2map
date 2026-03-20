# Credential / Device Consolidation -- Implementation Plan

## Overview

Consolidate the Credential and Device tables so that **Device is the single source of truth** for device metadata (rack_id, class_id, model_id, vendor, model, location, label) and **Credential becomes a pure SNMP connection config table** linked by FK to Device instead of by IP string matching.

This eliminates all bidirectional sync code and establishes clean data ownership.

**Analysis document:** `docs/SubAgent/CREDENTIAL_DEVICE_CONSOLIDATION_ANALYSIS.md`

---

## Phase 1: Database Migration (Alembic)

### Migration: `012_consolidate_credential_device.py`

Revision `012`, down_revision `011`.

#### Step 1.1: Add new columns to Device

Add these columns to the `devices` table:

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `label` | String | `""` | User-friendly display name (migrated from Credential) |
| `enabled` | Boolean | `True` | Whether to include in scans |
| `is_managed` | Boolean | `False` | Replaces implicit "has credential" check |

```python
op.add_column("devices", sa.Column("label", sa.String, server_default="", nullable=False))
op.add_column("devices", sa.Column("enabled", sa.Boolean, server_default="true", nullable=False))
op.add_column("devices", sa.Column("is_managed", sa.Boolean, server_default="false", nullable=False))
```

#### Step 1.2: Add `device_id` FK column to Credential

Add a nullable FK from Credential to Device. Nullable because a credential may be created before its device is first discovered by a scan.

```python
op.add_column("credentials", sa.Column("device_id", sa.Integer, sa.ForeignKey("devices.id", ondelete="SET NULL"), nullable=True))
op.create_index("ix_credentials_device_id", "credentials", ["device_id"])
```

#### Step 1.3: Data migration (populate new columns)

Run raw SQL to copy metadata from existing credentials to devices, matched by IP.

**1.3a: Populate `device_id` on Credential by matching IP**

```sql
UPDATE credentials
SET device_id = (SELECT d.id FROM devices d WHERE d.ip = credentials.ip LIMIT 1)
WHERE EXISTS (SELECT 1 FROM devices d WHERE d.ip = credentials.ip);
```

**1.3b: Copy rack_id, class_id, vendor, model, location, label from primary Credential (priority=0) to Device**

For each IP where a credential exists and a device exists, copy the primary credential's metadata to the device. Credential values take precedence (the credential was historically authoritative):

```sql
UPDATE devices
SET
    label = COALESCE((SELECT c.label FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1), devices.sys_name),
    rack_id = COALESCE((SELECT c.rack_id FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1), devices.rack_id),
    class_id = COALESCE((SELECT c.class_id FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1), devices.class_id),
    vendor = CASE
        WHEN (SELECT c.vendor FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1) != ''
        THEN (SELECT c.vendor FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1)
        ELSE devices.vendor
    END,
    model = CASE
        WHEN (SELECT c.model FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1) != ''
        THEN (SELECT c.model FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1)
        ELSE devices.model
    END,
    location = CASE
        WHEN (SELECT c.location FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1) != ''
        THEN (SELECT c.location FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1)
        ELSE devices.location
    END,
    is_managed = true,
    enabled = COALESCE((SELECT c.enabled FROM credentials c WHERE c.ip = devices.ip AND c.priority = 0 LIMIT 1), true)
WHERE EXISTS (SELECT 1 FROM credentials c WHERE c.ip = devices.ip);
```

**1.3c: Handle credentials without matching devices**

Credentials that exist without a matching device row (device hasn't been discovered yet) keep `device_id = NULL`. The FK is nullable, so this is safe. When the scan engine later discovers the device, it will link the credential.

#### Step 1.4: Drop duplicated columns from Credential

Remove the metadata columns that now live exclusively on Device:

```python
op.drop_constraint("credentials_rack_id_fkey", "credentials", type_="foreignkey")  # if named
op.drop_constraint("credentials_class_id_fkey", "credentials", type_="foreignkey")  # if named
op.drop_column("credentials", "rack_id")
op.drop_column("credentials", "class_id")
op.drop_column("credentials", "vendor")
op.drop_column("credentials", "model")
op.drop_column("credentials", "location")
```

> Note: `label` stays on Credential as a descriptive name for the SNMP config entry (e.g. "v3 backup creds for core switch"). `Device.label` is the device display name.

#### Step 1.5: Downgrade function

Reverse all changes: re-add columns to Credential, copy data back from Device, drop new Device columns, drop device_id from Credential.

#### Implementation Notes

- Use `op.execute()` for data migration SQL
- Wrap the data migration SQL in dialect-conditional blocks for PostgreSQL vs SQLite compatibility if needed (use `sa.text()`)
- The migration must be idempotent-safe: check column existence before dropping

---

## Phase 2: Backend Model Updates

### Step 2.1: Update `database.py` -- Credential model

**Remove from Credential:**
- `rack_id` column + FK
- `class_id` column + FK
- `vendor` column
- `model` column
- `location` column

**Add to Credential:**
- `device_id = Column(Integer, ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True)`
- `device = relationship("Device", back_populates="credentials", lazy="joined")`

**Current Credential columns (lines 108-142 of database.py):**
```
id, label, ip, priority, snmp_port, location, enabled,
snmp_version, community, v3_*, profile_id, rack_id, class_id, vendor, model
```

**New Credential columns:**
```
id, label, ip, priority, snmp_port, enabled,
snmp_version, community, v3_*, profile_id, device_id
```

### Step 2.2: Update `database.py` -- Device model

**Add to Device:**
- `label = Column(String, default="")`
- `enabled = Column(Boolean, default=True, nullable=False)`
- `is_managed = Column(Boolean, default=False, nullable=False)`
- `credentials = relationship("Credential", back_populates="device", lazy="selectin")`

**Current Device columns (lines 145-170 of database.py):**
```
id, sys_name, ip, sys_descr, model, vendor, location,
ping_status, ping_rtt_ms, last_ping, map_x, map_y, last_seen, ignored,
rack_id, class_id, model_id
```

**New Device columns:**
```
id, sys_name, ip, sys_descr, model, vendor, location,
ping_status, ping_rtt_ms, last_ping, map_x, map_y, last_seen, ignored,
rack_id, class_id, model_id,
label, enabled, is_managed
```

### Step 2.3: Update `schemas.py` -- Credential schemas

**CredentialBase** -- Remove:
- `location` field
- `rack_id` field
- `class_id` field
- `vendor` field
- `model` field

**CredentialBase** -- Add:
- `device_id: Optional[int] = None`

**CredentialCreate** -- Inherits from CredentialBase, no further changes needed (rack_id etc. removed via base).

**CredentialUpdate** -- Remove:
- `location` field
- `rack_id` field
- `class_id` field
- `vendor` field
- `model` field

**CredentialUpdate** -- Add:
- `device_id: Optional[int] = None`

**CredentialOut** -- Inherits from CredentialBase, add:
- `device_id: Optional[int] = None` (already inherited)

### Step 2.4: Update `schemas.py` -- Device schemas

**DeviceBase** -- Add:
- `label: str = ""`
- `enabled: bool = True`
- `is_managed: bool = False`

**DeviceOut** -- Already has `rack_id`, `class_id`, `model_id`. Add:
- `label: str = ""`
- `enabled: bool = True`
- `is_managed: bool = False`

**DeviceMetaUpdate** -- Add:
- `label: Optional[str] = None`
- `enabled: Optional[bool] = None`

**BulkDeviceMetaUpdate** -- No changes needed (already has rack_id, class_id).

### Step 2.5: Update `routers/credentials.py`

**`create_credential` (POST /api/credentials):**
- Remove the 6-line block (lines ~50-55) that syncs rack_id/class_id from credential to device:
  ```python
  # REMOVE THIS BLOCK:
  device = db.query(Device).filter(Device.ip == body.ip).first()
  if device:
      if cred.rack_id is not None:
          device.rack_id = cred.rack_id
      if cred.class_id is not None:
          device.class_id = cred.class_id
  ```
- If `body.device_id` is not provided but `body.ip` is set, auto-link by looking up device:
  ```python
  if not cred.device_id:
      device = db.query(Device).filter(Device.ip == body.ip).first()
      if device:
          cred.device_id = device.id
  ```

**`update_credential` (PUT /api/credentials/{id}):**
- Remove the entire rack_id/class_id validation block (lines ~85-93)
- Remove the entire device sync block (lines ~98-102):
  ```python
  # REMOVE THIS BLOCK:
  if device:
      if "rack_id" in updates:
          device.rack_id = cred.rack_id
      if "class_id" in updates:
          device.class_id = cred.class_id
  ```
- Remove the rack/class existence validation since credentials no longer carry rack_id/class_id
- Remove import of `Rack as RackModel` and `SwitchClass as SwitchClassModel` from this file

**`delete_credential` (DELETE /api/credentials/{id}):**
- No structural changes needed. The FK from credential to device uses `ondelete="SET NULL"` on the credential side, so deleting a credential does not affect the device.

### Step 2.6: Update `routers/topology.py`

**`get_topology` (GET /api/topology):**
- Replace the credential-IP subquery filter with `is_managed` flag:
  ```python
  # BEFORE:
  cred_ip_subq = db.query(Credential.ip).subquery()
  nodes = db.query(Device).filter(
      Device.ignored == False,
      Device.ip.in_(db.query(cred_ip_subq.c.ip)),
  ).all()

  # AFTER:
  nodes = db.query(Device).filter(
      Device.ignored == False,
      Device.is_managed == True,
  ).all()
  ```
- Remove `from database import ... Credential` import if no other usage remains in this file

**`bulk_update_device_meta` (PATCH /api/topology/devices/bulk-meta):**
- Remove the entire Credential sync block (lines ~183-191):
  ```python
  # REMOVE THIS BLOCK:
  cred_updates = {}
  if "rack_id" in updates:
      cred_updates["rack_id"] = updates["rack_id"]
  if "class_id" in updates:
      cred_updates["class_id"] = updates["class_id"]
  if cred_updates:
      affected_ips = [d.ip for d in db.query(Device.ip).filter(Device.id.in_(body.device_ids)).all()]
      if affected_ips:
          db.query(Credential).filter(Credential.ip.in_(affected_ips)).update(cred_updates, synchronize_session="fetch")
  ```

**`update_device_meta` (PATCH /api/topology/devices/{id}/meta):**
- Add handling for new `label` and `enabled` fields from DeviceMetaUpdate:
  ```python
  if "label" in payload:
      device.label = payload["label"]
  if "enabled" in payload:
      device.enabled = payload["enabled"]
  ```
- Remove the Credential sync block (lines ~247-252):
  ```python
  # REMOVE THIS BLOCK:
  if "rack_id" in payload or "class_id" in payload:
      cred = db.query(Credential).filter(Credential.ip == device.ip).first()
      if cred:
          if "rack_id" in payload:
              cred.rack_id = payload.get("rack_id")
          if "class_id" in payload:
              cred.class_id = payload.get("class_id")
  ```

**`list_all_devices` (GET /api/devices):**
- Replace the credential-IP subquery filter with `is_managed` flag:
  ```python
  # BEFORE:
  cred_ip_subq = db.query(Credential.ip).subquery()
  if role == "network":
      query = query.filter(Device.ip.in_(db.query(cred_ip_subq.c.ip)))
  else:
      query = query.filter(~Device.ip.in_(db.query(cred_ip_subq.c.ip)))

  # AFTER:
  if role == "network":
      query = query.filter(Device.is_managed == True)
  else:
      query = query.filter(Device.is_managed == False)
  ```

### Step 2.7: Update `scan_engine/executor.py`

**Auto-credential creation for range probes (line ~455-490):**
- When auto-creating a new Credential for a discovered IP, do NOT set `rack_id`, `class_id`, `vendor`, `model` on the credential (those fields no longer exist on Credential)
- Remove `location` from credential creation
- After creating the device row, set `credential.device_id = device.id`
- Set `device.is_managed = True` when a credential exists

**Device upsert loop (line ~520-570):**
- Remove the credential->device metadata sync for rack_id/class_id:
  ```python
  # REMOVE THIS BLOCK:
  if cred:
      target_rack_id = cred.rack_id if cred.rack_id is not None else device.rack_id
      target_class_id = cred.class_id if cred.class_id is not None else device.class_id
      ...
      if cred.rack_id is not None:
          device.rack_id = cred.rack_id
      if cred.class_id is not None:
          device.class_id = cred.class_id
  ```
- Remove the vendor/model override logic that reads from credential:
  ```python
  # BEFORE:
  vendor = cred.vendor if (cred and cred.vendor) else (sw.vendor if sw else "generic")
  model = cred.model if (cred and cred.model) else (extract_model(...))

  # AFTER -- read override from Device itself:
  vendor = (sw.vendor if sw else "generic") if not device or not device.vendor else device.vendor
  model = (extract_model(sw.sys_descr, sw.vendor) if sw else "") if not device or not device.model else device.model
  ```
  Actually, for new devices there is no device object yet. Simplify:
  - For existing devices: keep existing `device.vendor`/`device.model` if non-empty, otherwise use scan data
  - For new devices: use scan data directly
  - Vendor/model overrides are now edited on the Device side via the `/api/topology/devices/{id}/meta` endpoint
- Set `device.is_managed = True` for any device that has a matching credential
- Set `device.label` from credential label if device.label is empty
- After device creation/update, link credential: `cred.device_id = device.id`

**Credential lookup change:**
- Currently `cred_by_ip` is used to find credentials by IP: `{c.ip: c for c in db.query(Credential)...}`
- This pattern stays the same (lookup still by IP during scan), but after device creation the credential gets its device_id set

**New device creation block (line ~560-580):**
- Remove `rack_id = cred.rack_id if cred else None`
- Remove `class_id = cred.class_id if cred else None`
- Set `is_managed = True` if a credential exists for this IP
- Set `label = cred.label if cred else ""`
- Set `enabled = True` (new field default)

### Step 2.8: Update `routers/bulk.py`

**CREDENTIAL_BULK_FIELDS (line ~33-38):**
Remove: `"location"`, `"rack_id"`, `"class_id"`, `"vendor"`, `"model"`

New list:
```python
CREDENTIAL_BULK_FIELDS = [
    "label", "ip", "snmp_port", "enabled",
    "snmp_version", "community",
    "v3_security_level", "v3_username",
    "v3_auth_protocol", "v3_auth_password",
    "v3_priv_protocol", "v3_priv_password",
    "profile_id", "device_id",
]
```

**`bulk_export` (GET /api/bulk-export/credentials):**
- Remove `location`, `rack_id`, `class_id`, `vendor`, `model` from the credential export dict
- Add `device_id` to the export dict

**`_parse_bulk_rows`:**
- Remove `"rack_id"`, `"class_id"` from the `_normalize_optional_int` loop for credentials
- Add `"device_id"` to the `_normalize_optional_int` loop

**`bulk_import` (POST /api/bulk-import/credentials):**
- No structural changes beyond what CredentialCreate schema changes require (the removed fields won't be in the schema so they'll be ignored/rejected)

### Step 2.9: Update `routers/config.py`

**`export_global_config` (GET /api/config/export):**
- Remove `rack_id`, `class_id`, `vendor`, `model`, `location` from the credential dict in the export:
  ```python
  # Remove these lines from the credential dict:
  "location": c.location,
  "rack_id": c.rack_id,
  "class_id": c.class_id,
  "vendor": c.vendor,
  "model": c.model,
  ```
- Add `"device_id": c.device_id`

**`import_global_config` (POST /api/config/import):**
- Remove `"rack_id"`, `"class_id"` from the `_normalize_optional_int` loop
- Add `"device_id"` to the `_normalize_optional_int` loop

### Step 2.10: Update `seed_db.py`

- Remove `location` from Credential creation (line ~395)
- Remove `rack_id`, `class_id`, `vendor`, `model` from Credential if present (they are not currently set in seed, but remove any references)
- After device creation and flush, set `device_id` on credentials:
  ```python
  for sw, role in [(fs1,"TOR-1"), ...]:
      cred = Credential(
          label=f"...",
          ip=sw.ip,
          device_id=sw.id,  # NEW: direct FK link
          ...
      )
  ```
- Set `is_managed=True`, `enabled=True`, `label=f"..."` on Device creation

---

## Phase 3: Frontend Updates

### Step 3.1: Update `frontend/src/types.ts` -- Credential interface

**Remove from Credential interface (line ~197-218):**
- `location: string`
- `rack_id: number | null`
- `class_id: number | null`
- `vendor: string`
- `model: string`

**Add to Credential interface:**
- `device_id: number | null`

**Update TopologyNode interface:**
- Add `label: string`
- Add `enabled: boolean`
- Add `is_managed: boolean`

### Step 3.2: Update `frontend/src/components/settings/CredentialsTab.tsx`

**CredentialForm interface (line ~6-27):**
- Remove: `location`, `rack_id`, `class_id`, `vendor`, `model`
- Add: `device_id: number | null`

**EMPTY_FORM (line ~41-50):**
- Remove: `location:""`, `rack_id: null`, `class_id: null`, `vendor:"generic"`, `model:""`
- Add: `device_id: null`

**startEdit function (line ~98-110):**
- Remove: `location`, `rack_id`, `class_id`, `vendor`, `model` from form population
- Add: `device_id: c.device_id ?? null`

**Form UI (the modal form, lines ~190-248):**
- Remove these form fields:
  - Location input
  - Vendor select
  - Model select
  - Rack select
  - Class select
- These metadata fields are now managed on the Device via the topology/device meta endpoints, not on the credential form

**Credential card display (lines ~360-420):**
- The `assignedRack` lookup currently uses `c.rack_id`. Change this to look up from the matched device:
  ```tsx
  // BEFORE:
  const assignedRack = c.rack_id ? racks.find(r => r.id === c.rack_id) : null;

  // AFTER:
  const matchedDevice = devices.find(d => d.ip === c.ip);
  const assignedRack = matchedDevice?.rack_id ? racks.find(r => r.id === matchedDevice.rack_id) : null;
  ```
  (Note: `matchedDevice` lookup already exists on line 379 of the current code)

**"Add credentials" button for unassigned devices (line ~480-490):**
- Remove `location`, `vendor`, `model` from the form prefill
- Add `device_id: d.id` to the form prefill

### Step 3.3: Other frontend files (no changes needed)

- `DeviceTable.tsx` -- already reads rack_id/class_id from Device, no credential references
- `DashboardPage.tsx` -- reads from topology nodes (Device), not credentials
- `store.ts` -- reads rack_id from topology nodes (Device), not credentials
- `useRackOrders.ts` -- reads class_id from Device, not credentials

---

## Phase 4: Test Updates

### Step 4.1: Update `tests/test_credentials.py`

- All existing tests create credentials with `label`, `ip`, `community` -- these fields still exist, so tests remain valid
- Add a test for `device_id` linkage on credential create
- Verify that rack_id/class_id/vendor/model are not accepted in credential payloads (should be rejected or ignored)

### Step 4.2: Update `tests/test_topology.py`

**`test_topology_excludes_device_without_credential` (line ~71-78):**
- This test verifies a device without a credential is excluded. After consolidation, the check is `is_managed == False` instead:
  ```python
  # BEFORE: Device excluded because no matching credential IP
  # AFTER: Device excluded because is_managed=False (default)
  ```
  The test should still pass since new devices default to `is_managed=False`

**`test_topology_includes_seeded_device` (line ~19-45):**
- Currently creates a Credential and Device with matching IP. After consolidation:
  - Still create Credential (for the device to be scannable), but set `device.is_managed = True`
  - The topology filter now uses `is_managed=True` instead of credential-IP join

**`test_update_device_meta_syncs_credential` (line ~82-100):**
- This test explicitly verifies that device meta updates sync to credential. After consolidation, this sync is removed. Either:
  - Delete this test entirely (the sync no longer exists)
  - Or rewrite it to verify that credential is NOT modified when device meta is updated

**`test_bulk_update_device_meta_syncs_credentials` (line ~103-130):**
- Same as above -- delete or rewrite to verify no sync

### Step 4.3: Update `tests/test_bulk.py`

- Tests that create `Credential(...)` objects with `rack_id`, `class_id`, `vendor`, `model` need those fields removed
- Bulk export tests: verify credential exports no longer contain `rack_id`, `class_id`, `vendor`, `model`
- Bulk import tests: verify credential imports work without metadata fields

### Step 4.4: Update `tests/test_config.py`

- `test_config_export_masks_passwords`: Credential creation removes `rack_id`, `class_id`, `vendor`, `model`
- Credential rows in export should no longer contain those fields
- Update assertions accordingly

### Step 4.5: Update `tests/test_cascade.py`

- Add a test verifying that deleting a Device sets `credential.device_id = NULL` (via `ondelete="SET NULL"`)

### Step 4.6: Update `tests/test_audit.py`

- Credential create/delete tests are minimal and don't reference removed fields, so no changes needed

---

## Implementation Checklist

### Phase 1: Alembic Migration
- [ ] Create `backend/alembic/versions/012_consolidate_credential_device.py`
- [ ] Add `label`, `enabled`, `is_managed` columns to `devices` table
- [ ] Add `device_id` FK column to `credentials` table
- [ ] Data migration: populate `device_id` by matching IP
- [ ] Data migration: copy metadata from primary credential to device
- [ ] Data migration: set `is_managed=True` on devices with credentials
- [ ] Drop `rack_id`, `class_id`, `vendor`, `model`, `location` from `credentials`
- [ ] Write downgrade function

### Phase 2: Backend Models & Routers
- [ ] Update `database.py` -- Credential model (remove columns, add device_id FK & relationship)
- [ ] Update `database.py` -- Device model (add label, enabled, is_managed & credentials relationship)
- [ ] Update `schemas.py` -- CredentialBase/Create/Update/Out (remove metadata fields, add device_id)
- [ ] Update `schemas.py` -- DeviceBase/Out/MetaUpdate (add label, enabled, is_managed)
- [ ] Update `routers/credentials.py` -- remove all sync code, auto-link device_id
- [ ] Update `routers/topology.py` -- replace credential-IP filter with is_managed, remove all sync code
- [ ] Update `scan_engine/executor.py` -- remove credential->device sync, set device_id/is_managed
- [ ] Update `routers/bulk.py` -- remove metadata fields from credential bulk, add device_id
- [ ] Update `routers/config.py` -- remove metadata fields from credential export/import
- [ ] Update `seed_db.py` -- set device_id on credentials, set is_managed/label on devices

### Phase 3: Frontend
- [ ] Update `types.ts` -- Credential interface (remove metadata, add device_id)
- [ ] Update `types.ts` -- TopologyNode interface (add label, enabled, is_managed)
- [ ] Update `CredentialsTab.tsx` -- remove metadata fields from form, read metadata from device

### Phase 4: Tests
- [ ] Update `test_credentials.py` -- add device_id linkage test
- [ ] Update `test_topology.py` -- rewrite sync tests, update filter tests
- [ ] Update `test_bulk.py` -- remove metadata fields from credential bulk tests
- [ ] Update `test_config.py` -- remove metadata fields from credential config tests
- [ ] Update `test_cascade.py` -- add credential device_id SET NULL test

---

## Risk Mitigation

### Backward Compatibility
- The Alembic migration handles data transfer automatically
- Existing deployments will have their credential metadata merged into devices
- The API changes are breaking: clients sending `rack_id`/`class_id`/`vendor`/`model` on credential endpoints will get validation errors from Pydantic

### Data Loss Prevention
- The migration COPIES data, never deletes without copying first
- The downgrade function can reverse the migration
- Multiple credentials per IP (priority-based fallback): only the primary (priority=0) credential's metadata is used for the device during migration

### Edge Cases
- **Credential without device**: `device_id` stays NULL until the next scan discovers the device
- **Device without credential**: `is_managed` stays False, device is treated as endpoint
- **Multiple credentials for same IP**: All share the same `device_id` FK; the primary one's metadata was migrated to the device
- **Rack/class validation on device**: The `allow_outside_rack` validation stays on the device meta update endpoint unchanged

---

## File Change Summary

| File | Changes |
|------|---------|
| `alembic/versions/012_consolidate_credential_device.py` | NEW -- migration |
| `database.py` | Credential: remove 5 cols, add device_id + relationship. Device: add 3 cols + relationship |
| `schemas.py` | CredentialBase/Update: remove 5 fields, add device_id. DeviceBase/Out/MetaUpdate: add 3 fields |
| `routers/credentials.py` | Remove ~20 lines of sync code, add auto-link device_id |
| `routers/topology.py` | Remove ~25 lines of sync code, replace IP filter with is_managed |
| `scan_engine/executor.py` | Remove ~30 lines of metadata sync, add device_id linking + is_managed |
| `routers/bulk.py` | Remove 5 fields from CREDENTIAL_BULK_FIELDS, update export/import |
| `routers/config.py` | Remove 5 fields from credential export/import dicts |
| `seed_db.py` | Add device_id to credentials, add is_managed/label to devices |
| `frontend/src/types.ts` | Credential: remove 5 fields, add device_id. TopologyNode: add 3 fields |
| `frontend/src/components/settings/CredentialsTab.tsx` | Remove ~5 form fields, read metadata from device |
| `tests/test_credentials.py` | Add device_id linkage test |
| `tests/test_topology.py` | Rewrite/delete sync tests, update filter tests |
| `tests/test_bulk.py` | Remove metadata fields from credential tests |
| `tests/test_config.py` | Remove metadata fields from credential config tests |
| `tests/test_cascade.py` | Add credential device_id cascade test |
