# Plan: Sync Device Meta Updates to Credential Records

## Problem

When rack/class/model is assigned via Settings tabs (RacksTab, SwitchClassesTab, SwitchModelsTab) or the DeviceTable edit form, the backend `update_device_meta()` and `bulk_update_device_meta()` in `backend/routers/topology.py` only update the `Device` record. The corresponding `Credential` record is NOT updated. This causes stale data in the CredentialsTab edit form and can lead to the stale Credential values overwriting the Device values when the credential is saved.

The reverse direction (Credential -> Device) already works correctly in `backend/routers/credentials.py`.

## Approach

Backend-only fix (Option A from analysis). Sync `rack_id` and `class_id` from Device to Credential after every device meta update. No frontend changes needed -- once both records are always in sync, the CredentialsTab form naturally shows correct data.

Additionally, add `"/api/credentials"` to ETag cache invalidation in the frontend Settings tabs so the CredentialsTab picks up the change without a hard refresh.

---

## Checklist

### Step 1: Update `update_device_meta()` in `backend/routers/topology.py`

- [ ] After `db.commit()` / `db.refresh(device)` (around line 234), add sync logic to update the matching Credential record.
- [ ] Match by IP: `db.query(Credential).filter(Credential.ip == device.ip).first()`
- [ ] Only sync when `rack_id` or `class_id` was in the payload.
- [ ] Set `cred.rack_id = device.rack_id` and/or `cred.class_id = device.class_id`.
- [ ] Call `db.commit()` again (or move the credential update before the existing commit).

**Exact change (insert BEFORE `db.commit()`, around line 230):**

After the block that applies individual fields to `device` (ending with the `ignored` check), and BEFORE the `db.commit()` call, add:

```python
    # Sync rack_id / class_id to matching Credential record
    if "rack_id" in payload or "class_id" in payload:
        cred = db.query(Credential).filter(Credential.ip == device.ip).first()
        if cred:
            if "rack_id" in payload:
                cred.rack_id = payload.get("rack_id")
            if "class_id" in payload:
                cred.class_id = payload.get("class_id")
```

This goes BEFORE `db.commit()` so both Device and Credential updates are committed in a single transaction.

### Step 2: Update `bulk_update_device_meta()` in `backend/routers/topology.py`

- [ ] After the bulk `.update()` call (line 175), sync `rack_id` and/or `class_id` to Credential records for all affected devices.
- [ ] Query the IPs of affected devices, then bulk-update matching Credentials.

**Exact change (insert BEFORE `db.commit()`, around line 176):**

After the `db.query(Device)...update(updates)` call and BEFORE `db.commit()`, add:

```python
    # Sync rack_id / class_id to matching Credential records
    cred_updates = {}
    if "rack_id" in updates:
        cred_updates["rack_id"] = updates["rack_id"]
    if "class_id" in updates:
        cred_updates["class_id"] = updates["class_id"]
    if cred_updates:
        affected_ips = [
            d.ip for d in db.query(Device.ip).filter(Device.id.in_(body.device_ids)).all()
        ]
        if affected_ips:
            db.query(Credential).filter(Credential.ip.in_(affected_ips)).update(
                cred_updates, synchronize_session="fetch"
            )
```

### Step 3: Add ETag invalidation for `/api/credentials` in frontend Settings tabs

When Settings tabs call `PATCH /api/topology/devices/{id}/meta`, the backend now also updates the Credential. The frontend must invalidate the `/api/credentials` ETag cache so the CredentialsTab fetches fresh data.

- [ ] **`frontend/src/components/settings/RacksTab.tsx`** (lines 77, 84): Add `"/api/credentials"` to both `api.invalidate(...)` calls.

  Before: `api.invalidate("/api/topology", "/api/racks", "/api/devices?role=network");`
  After:  `api.invalidate("/api/topology", "/api/racks", "/api/devices?role=network", "/api/credentials");`

- [ ] **`frontend/src/components/settings/SwitchClassesTab.tsx`** (lines 84, 94): Add `"/api/credentials"` to both `api.invalidate(...)` calls.

  Before: `api.invalidate("/api/topology", "/api/devices?role=network");`
  After:  `api.invalidate("/api/topology", "/api/devices?role=network", "/api/credentials");`

- [ ] **`frontend/src/components/settings/SwitchModelsTab.tsx`** (lines 92, 99): Add `"/api/credentials"` to both `api.invalidate(...)` calls.

  Before: `api.invalidate("/api/topology", "/api/devices?role=network");`
  After:  `api.invalidate("/api/topology", "/api/devices?role=network", "/api/credentials");`

### Step 4: Add test for Device -> Credential sync

- [ ] Add test `test_update_device_meta_syncs_credential` in `backend/tests/test_topology.py`.
- [ ] Create a Device and Credential with the same IP, a Rack, and a SwitchClass.
- [ ] PATCH `/api/topology/devices/{id}/meta` with `rack_id` and `class_id`.
- [ ] Assert the Credential record now has the same `rack_id` and `class_id`.
- [ ] Add test `test_bulk_update_device_meta_syncs_credentials` with similar logic for the bulk endpoint.

### Step 5: Update VERSION.md

- [ ] Add entry under Recent Changes for the Device -> Credential sync fix.

---

## Files Modified

| File | Change |
|------|--------|
| `backend/routers/topology.py` | Add Credential sync in `update_device_meta()` and `bulk_update_device_meta()` |
| `frontend/src/components/settings/RacksTab.tsx` | Add `"/api/credentials"` to ETag invalidation |
| `frontend/src/components/settings/SwitchClassesTab.tsx` | Add `"/api/credentials"` to ETag invalidation |
| `frontend/src/components/settings/SwitchModelsTab.tsx` | Add `"/api/credentials"` to ETag invalidation |
| `backend/tests/test_topology.py` | Add sync tests |
| `VERSION.md` | Changelog entry |

## Risk Assessment

- **Low risk**: The sync logic mirrors the existing Credential -> Device sync in `credentials.py`.
- `Credential` is already imported in `topology.py` (line 15).
- Single-transaction commit ensures atomicity.
- Bulk endpoint uses efficient `.update()` query rather than per-row updates.
