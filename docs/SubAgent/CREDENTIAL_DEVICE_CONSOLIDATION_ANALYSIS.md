# Credential / Device Consolidation Analysis

## 1. Current Schema Overview

### Credential Table (`credentials`)
User-created record representing "a switch I want to manage." Fields:

| Column | Purpose |
|--------|---------|
| `id` | PK |
| `label` | Friendly name |
| `ip` | Switch IP (unique per priority) |
| `priority` | Fallback order (composite unique with ip) |
| `snmp_port` | SNMP port (default 161) |
| `location` | Free-text location string |
| `enabled` | Whether to scan this entry |
| `snmp_version` | v2c or v3 |
| `community` | SNMPv2c community |
| `v3_security_level` | noAuthNoPriv / authNoPriv / authPriv |
| `v3_username` | SNMPv3 username |
| `v3_auth_protocol` | Auth algorithm |
| `v3_auth_password` | Auth password (encrypted) |
| `v3_priv_protocol` | Privacy algorithm |
| `v3_priv_password` | Privacy password (encrypted) |
| `profile_id` | FK -> snmp_profiles (optional shared profile) |
| `rack_id` | FK -> racks |
| `class_id` | FK -> switch_classes |
| `vendor` | Manual vendor override (empty = autodetect) |
| `model` | Manual model override (empty = autodetect) |
| `created_at` | Timestamp |
| `updated_at` | Timestamp |

### Device Table (`devices`)
Scan-engine-created record representing "a switch we discovered." Fields:

| Column | Purpose |
|--------|---------|
| `id` | PK |
| `sys_name` | SNMP sysName |
| `ip` | Switch IP (unique) |
| `sys_descr` | SNMP sysDescr |
| `model` | Detected or overridden model string |
| `vendor` | Detected or overridden vendor ID |
| `location` | SNMP sysLocation |
| `ping_status` | online / offline / unknown |
| `ping_rtt_ms` | Last ping RTT |
| `last_ping` | Last ping timestamp |
| `map_x` | Map canvas X position |
| `map_y` | Map canvas Y position |
| `last_seen` | Last scan timestamp |
| `ignored` | Hide from topology view |
| `rack_id` | FK -> racks |
| `class_id` | FK -> switch_classes |
| `model_id` | FK -> switch_models |
| `ports` | Relationship -> Port[] |
| `rack` | Relationship -> Rack |
| `switch_class` | Relationship -> SwitchClass |
| `switch_model` | Relationship -> SwitchModel |


## 2. Column Comparison

### Data ONLY on Credential (not on Device)
| Column | Notes |
|--------|-------|
| `label` | User-friendly display name |
| `priority` | Fallback credential ordering |
| `snmp_port` | SNMP port override |
| `enabled` | Scan on/off toggle |
| `snmp_version` | SNMP version selection |
| `community` | SNMPv2c community string |
| `v3_*` (6 fields) | All SNMPv3 auth/priv settings |
| `profile_id` | Link to shared SNMP profile |

### Data ONLY on Device (not on Credential)
| Column | Notes |
|--------|-------|
| `sys_name` | Discovered via SNMP |
| `sys_descr` | Discovered via SNMP |
| `ping_status` | Runtime scan result |
| `ping_rtt_ms` | Runtime scan result |
| `last_ping` | Runtime scan result |
| `map_x` / `map_y` | UI drag-drop position |
| `last_seen` | Last successful scan |
| `ignored` | User toggle |
| `model_id` | FK to switch_models catalog |
| `ports` | Port relationship |

### DUPLICATED Data (on BOTH tables)
| Column | Credential role | Device role | Sync behavior |
|--------|----------------|-------------|---------------|
| `ip` | User-entered target | Discovered target | Matched by IP join |
| `rack_id` | User assigns rack | Scan copies from cred | Bidirectional sync code |
| `class_id` | User assigns class | Scan copies from cred | Bidirectional sync code |
| `vendor` | Manual override | Autodetected value | Credential overrides device on scan |
| `model` | Manual override | Autodetected value | Credential overrides device on scan |
| `location` | User-entered text | SNMP sysLocation | No sync -- independent values |


## 3. Lifecycle Analysis

### Credential Lifecycle
1. **Manual creation**: User adds a switch via UI form (POST `/api/credentials`)
2. **Auto-creation**: Scan engine creates credentials for IPs found via discovery range probes (`executor.py` line ~455-490)
3. **Bulk import**: CSV/JSON import via `/api/bulk-import/credentials`
4. **Manual updates**: User edits SNMP settings, rack/class assignment
5. **Deletion**: User removes a credential; device row persists

### Device Lifecycle
1. **Auto-creation**: Scan engine creates device rows for any IP that responds to SNMP (`executor.py` line ~546-570)
2. **Auto-update**: Every scan refreshes sys_name, sys_descr, vendor, model, ping status, last_seen
3. **Manual meta update**: User can edit via `/api/topology/devices/{id}/meta` (rack, class, model, vendor, etc.)
4. **Never manually created**: No `POST /api/devices` endpoint exists

### The Relationship
- A Credential is the "intent" -- "I want to manage this switch"
- A Device is the "reality" -- "This switch was discovered and scanned"
- They are linked by `ip` (loose join, no FK)
- The topology endpoint **filters devices to only those with matching credentials** (`Device.ip IN (SELECT ip FROM credentials)`)
- Discovery-scanned IPs have credentials auto-created so they appear in topology


## 4. Current Sync Pain Points

### Bidirectional Sync Code is Scattered and Fragile
The system tries to keep `rack_id` and `class_id` in sync between the two tables:

1. **credentials.py `create_credential`** (line ~50-55): When creating a credential, if a device with that IP exists, copy rack_id and class_id to the device.
2. **credentials.py `update_credential`** (line ~85-93): When updating a credential, sync rack_id/class_id to the matching device.
3. **topology.py `update_device_meta`** (line ~247-252): When updating a device, sync rack_id/class_id back to the matching credential.
4. **topology.py `bulk_update_device_meta`** (line ~183-191): Bulk device updates also sync back to credentials.
5. **executor.py `_execute_scan`** (line ~520-544): During scan, credential's rack_id/class_id override the device's values.

This means:
- Every write path must remember to sync the other table
- Missing a sync path = data drift between tables
- The scan engine **always** treats credential as authoritative for rack_id/class_id, potentially overwriting user edits on the device

### "Is this a network device?" Check Uses Credential Existence
```python
# topology.py line 95-98
cred_ip_subq = db.query(Credential.ip).subquery()
nodes = db.query(Device).filter(
    Device.ip.in_(db.query(cred_ip_subq.c.ip)),
).all()
```
A device without a credential is treated as an "endpoint" (non-network device). This is an implicit role assignment based on the existence of a credential row, rather than an explicit flag.

### vendor/model Override Logic is Implicit
```python
# executor.py line ~517-518
vendor = cred.vendor if (cred and cred.vendor) else (sw.vendor if sw else "generic")
model = cred.model  if (cred and cred.model)  else (extract_model(...))
```
Empty string on credential means "autodetect." This is a convention, not enforced by schema.

### No FK Between Credential and Device
The link is purely by IP string matching. If a credential's IP is edited, the old device row becomes "orphaned" (still exists but no longer appears in topology). No cascade, no referential integrity.


## 5. What Other Systems Do

The dual-table design is a variant of the "desired state vs. actual state" pattern:
- **Credential** = desired state ("scan this IP with these SNMP settings, assign it to this rack")
- **Device** = actual state ("this is what we discovered at that IP")

This is a valid pattern, but the problem is that **metadata ownership is split** between the two tables with ad-hoc sync logic.


## 6. Proposed Consolidation Strategy

### Option A: Device as Single Source of Truth + Credential for SNMP Only

Make **Device** the single source of truth for all switch metadata. Keep **Credential** as a pure SNMP connection configuration table (no metadata duplication).

**Device gains:**
- `label` (from Credential)
- `snmp_port`, `enabled` (from Credential, for scan targeting)
- `is_managed` boolean (replaces the "has credential" implicit check)

**Credential loses:**
- `rack_id`, `class_id` (move to Device only)
- `vendor`, `model` (move to Device only, with a separate override mechanism)
- `location` (use only Device.location)
- `label` becomes optional/description only

**Credential retains:**
- `ip` (FK to Device)
- `priority`
- All SNMP fields (version, community, v3_*)
- `profile_id`
- `enabled`
- `snmp_port`

**Pros:**
- One place for metadata; no sync code needed
- Clear separation: Device = what the switch is, Credential = how to connect
- Credential becomes a simple auth table

**Cons:**
- Breaking API change (credential create/update no longer accepts rack_id, class_id, etc.)
- Migration must merge existing data
- Frontend forms must change (credential form shrinks, device form expands)

### Option B: Merge into Device + Inline SNMP Fields

Eliminate the Credential table entirely. Add SNMP fields directly to Device.

**Pros:**
- Simplest model, one table for everything
- No sync needed

**Cons:**
- Device table becomes very wide
- Loses fallback credential chain (priority-based multiple credentials per IP)
- Loses SnmpProfile linkage
- Major breaking change

### Option C: Keep Both Tables, Add FK and Clear Ownership (Recommended)

1. Add `device_id` FK from Credential -> Device (nullable, set when device is discovered)
2. Remove `rack_id`, `class_id`, `vendor`, `model`, `location` from Credential
3. Device becomes the single authority for all metadata
4. Credential is purely SNMP connection config + which Device it targets
5. Add `is_managed` / `label` / `enabled` to Device to replace implicit credential-existence checks

**Pros:**
- Clear ownership with enforced FK
- Keeps fallback credential chain intact
- Keeps SnmpProfile system intact
- Eliminates all sync code
- The "is this a managed switch?" question is answered by `Device.is_managed` instead of credential existence
- Can be migrated incrementally

**Cons:**
- Still two tables (but with clean separation)
- Need a migration to move metadata from existing credentials to devices


## 7. Affected Code Paths (for any consolidation)

| File | What needs changing |
|------|-------------------|
| `database.py` | Model changes (add/remove columns, add FK) |
| `schemas.py` | Schema changes (CredentialCreate/Update shrink, DeviceOut/Meta expand) |
| `routers/credentials.py` | Remove rack_id/class_id/vendor/model sync code |
| `routers/topology.py` | Remove credential sync code, change "has credential" filter to `is_managed` |
| `scan_engine/executor.py` | Remove credential->device metadata sync, set `device_id` on credential on discovery |
| `routers/bulk.py` | Credential import/export fields change |
| `routers/config.py` | Credential-related config changes |
| `seed_db.py` | Seed data changes |
| `tests/*` | Update all credential/device tests |
| Frontend: credential forms | Remove metadata fields, link to device instead |
| Frontend: device/topology forms | Add label, enabled fields |
| Frontend: topology queries | Use `is_managed` flag instead of credential-IP join |
| Alembic migration | Data migration: copy rack_id/class_id/vendor/model from credentials to devices |


## 8. Data Migration Considerations

For existing deployments:
1. For each Credential with `rack_id`/`class_id`/`vendor`/`model` set, find the matching Device by IP
2. Copy those values to the Device (credential wins as it was historically authoritative)
3. Set `device.is_managed = True` for all devices that have a matching credential
4. Set `device.label = credential.label` for matching devices
5. Drop the duplicated columns from Credential
6. Add `device_id` FK to Credential, populate using IP join

### Risk: Multiple Credentials per IP (priority/fallback)
Since migration 008 allows multiple credentials per IP (different priorities), the FK should be nullable and the relationship should be `Device has many Credentials`. The primary credential (priority=0) should be used for label/metadata source during migration.


## 9. Summary of Findings

| Question | Answer |
|----------|--------|
| What data is on Credential only? | label, priority, snmp_port, enabled, all SNMP auth fields, profile_id |
| What data is on Device only? | sys_name, sys_descr, ping_status, ping_rtt_ms, last_ping, map_x/y, last_seen, ignored, model_id, ports |
| What is duplicated? | ip, rack_id, class_id, vendor, model, location |
| Credential lifecycle? | Manual create (user), auto-create (discovery), bulk import |
| Device lifecycle? | Auto-create (scan), auto-update (scan), manual meta edits |
| How should single source of truth work? | Device owns all metadata; Credential is pure SNMP connection config linked by FK |

**Recommended approach: Option C** -- Keep both tables with clear ownership, add FK, remove duplicated metadata from Credential, add `is_managed`/`label` to Device.
