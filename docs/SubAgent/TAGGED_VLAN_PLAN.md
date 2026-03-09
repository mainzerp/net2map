# Tagged VLAN Collection - Implementation Plan

Based on analysis: `docs/SubAgent/TAGGED_VLAN_ANALYSIS.md`

---

## Overview

Enhance the SNMP scanner to collect tagged VLAN memberships per port using Q-BRIDGE-MIB bitmask OIDs, persist them as JSONB, and display them in the frontend alongside the existing native VLAN.

---

## Implementation Checklist

### Step 1: Backend - snmp_scanner.py - Add OID Constants

**File:** `backend/snmp_scanner.py`
**Location:** After line 116 (`OID_DOT1Q_PVID = ...`)

Add three new OID constants:

```python
# BEFORE (line 116):
OID_DOT1Q_PVID = "1.3.6.1.2.1.17.7.1.4.5.1.1"  # dot1qPvid

# AFTER:
OID_DOT1Q_PVID = "1.3.6.1.2.1.17.7.1.4.5.1.1"  # dot1qPvid
OID_DOT1Q_VLAN_STATIC_EGRESS   = "1.3.6.1.2.1.17.7.1.4.3.1.2"  # dot1qVlanStaticEgressPorts
OID_DOT1Q_VLAN_STATIC_UNTAGGED = "1.3.6.1.2.1.17.7.1.4.3.1.4"  # dot1qVlanStaticUntaggedPorts
```

- [x] Task 1.1: Add `OID_DOT1Q_VLAN_STATIC_EGRESS` constant
- [x] Task 1.2: Add `OID_DOT1Q_VLAN_STATIC_UNTAGGED` constant

---

### Step 2: Backend - snmp_scanner.py - Add Raw-Bytes Bulk Walk Function

**File:** `backend/snmp_scanner.py`
**Location:** After the existing `snmp_bulk_walk()` function (ends ~line 315)

The existing `snmp_bulk_walk()` calls `_decode_snmp_str()` on all values, which corrupts binary OCTET STRING bitmask data. Add a new `snmp_bulk_walk_raw()` function that returns `(oid_str, bytes)` tuples instead.

```python
async def snmp_bulk_walk_raw(ip: str, port: int, auth,
                             oid: str, max_rows: int = 500,
                             timeout: int = 3,
                             retries: int = 1,
                             engine: Optional[SnmpEngine] = None) -> List[Tuple[str, bytes]]:
    """Async GETBULK walk returning raw bytes values (for OCTET STRING bitmasks).

    Identical to snmp_bulk_walk() except values are returned as raw bytes
    instead of decoded strings, preserving binary bitmask data.
    """
    rows: List[Tuple[str, bytes]] = []
    current_oid = oid
    bulk_size = 25
    own_engine = engine is None
    if own_engine:
        engine = SnmpEngine()
    try:
        while len(rows) < max_rows:
            try:
                error_indication, error_status, _, var_binds = await bulkCmd(
                    engine, auth, _transport(ip, port, timeout, retries), ContextData(),
                    0, bulk_size,
                    ObjectType(ObjectIdentity(current_oid)),
                )
            except Exception as exc:
                log.debug("snmp_bulk_walk_raw %s %s: %s", ip, oid, exc)
                break

            if error_indication or error_status:
                break

            if not var_binds:
                break

            advanced = False
            for row in var_binds:
                vb = row[0] if isinstance(row, (list, tuple)) else row
                vb_oid = str(vb[0])
                # Extract raw bytes - do NOT decode to string
                try:
                    vb_val = bytes(vb[1])
                except Exception:
                    vb_val = b""
                if not vb_oid.startswith(oid + ".") and vb_oid != oid:
                    return rows
                rows.append((vb_oid, vb_val))
                current_oid = vb_oid
                advanced = True
                if len(rows) >= max_rows:
                    return rows

            if not advanced:
                break
    finally:
        if own_engine:
            try:
                engine.transportDispatcher.closeDispatcher()
            except Exception:
                pass
    return rows
```

- [x] Task 2.1: Add `snmp_bulk_walk_raw()` function after `snmp_bulk_walk()`

---

### Step 3: Backend - snmp_scanner.py - Add Bitmask Parser Helper

**File:** `backend/snmp_scanner.py`
**Location:** After `snmp_bulk_walk_raw()` (before `detect_vendor()` at ~line 320)

```python
def parse_port_bitmask(data: bytes) -> set:
    """Parse Q-BRIDGE OCTET STRING port bitmask into set of bridge port numbers (1-indexed).

    Byte 0 bit 7 (MSB) = bridge port 1, byte 0 bit 6 = port 2, ...,
    byte 0 bit 0 = port 8, byte 1 bit 7 = port 9, etc.
    """
    ports = set()
    for byte_idx, byte_val in enumerate(data):
        for bit in range(8):
            if byte_val & (0x80 >> bit):
                ports.add(byte_idx * 8 + bit + 1)
    return ports
```

- [x] Task 3.1: Add `parse_port_bitmask()` helper function

---

### Step 4: Backend - snmp_scanner.py - Add tagged_vlans to IfInfo Dataclass

**File:** `backend/snmp_scanner.py`
**Location:** Line ~141, the `IfInfo` dataclass

```python
# BEFORE (lines 135-141):
@dataclass
class IfInfo:
    index:       int
    descr:       str = ""
    alias:       str = ""
    speed_mbps:  int = 0
    oper_status: int = 2
    vlan:        int = 0

# AFTER:
@dataclass
class IfInfo:
    index:       int
    descr:       str = ""
    alias:       str = ""
    speed_mbps:  int = 0
    oper_status: int = 2
    vlan:        int = 0
    tagged_vlans: List[int] = field(default_factory=list)
```

- [x] Task 4.1: Add `tagged_vlans` field to `IfInfo` with `field(default_factory=list)`

---

### Step 5: Backend - snmp_scanner.py - Extend Step 6 VLAN Collection

**File:** `backend/snmp_scanner.py`
**Location:** Lines 706-740 (the step 6 VLAN block inside `_scan_switch_inner()`)

After the existing PVID walk (line ~735, after the `for oid_s, val in pvid_rows:` loop), add tagged VLAN collection. The new code goes inside the existing `try:` block, after `sw.interfaces[ifindex].vlan = pvid` loop ends.

```python
# BEFORE (lines 706-740):
    # -- 6. VLAN (dot1qPvid) - fault-tolerant --------------------------------
    try:
        # If bridge_to_ifindex wasn't populated (no MAC walk), fetch it now
        if not bridge_to_ifindex:
            bp_rows = await snmp_bulk_walk(
                ip, snmp_port, auth, OID_DOT1D_BASE_PORT_IF_INDEX,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            )
            for oid_s, ifindex_val in bp_rows:
                try:
                    bp = int(_last_n(oid_s, 1)[0])
                    bridge_to_ifindex[bp] = int(ifindex_val)
                except ValueError:
                    continue

        pvid_rows = await snmp_bulk_walk(
            ip, snmp_port, auth, OID_DOT1Q_PVID,
            timeout=snmp_timeout, retries=snmp_retries, engine=engine,
        )
        for oid_s, val in pvid_rows:
            try:
                bp = int(_last_n(oid_s, 1)[0])
                pvid = int(val)
            except (ValueError, IndexError):
                continue
            ifindex = bridge_to_ifindex.get(bp)
            if ifindex is not None and ifindex in sw.interfaces:
                sw.interfaces[ifindex].vlan = pvid
    except Exception:
        log.debug("VLAN walk failed for %s (Q-BRIDGE-MIB not supported)", ip)

# AFTER:
    # -- 6. VLAN (dot1qPvid) - fault-tolerant --------------------------------
    try:
        # If bridge_to_ifindex wasn't populated (no MAC walk), fetch it now
        if not bridge_to_ifindex:
            bp_rows = await snmp_bulk_walk(
                ip, snmp_port, auth, OID_DOT1D_BASE_PORT_IF_INDEX,
                timeout=snmp_timeout, retries=snmp_retries, engine=engine,
            )
            for oid_s, ifindex_val in bp_rows:
                try:
                    bp = int(_last_n(oid_s, 1)[0])
                    bridge_to_ifindex[bp] = int(ifindex_val)
                except ValueError:
                    continue

        pvid_rows = await snmp_bulk_walk(
            ip, snmp_port, auth, OID_DOT1Q_PVID,
            timeout=snmp_timeout, retries=snmp_retries, engine=engine,
        )
        for oid_s, val in pvid_rows:
            try:
                bp = int(_last_n(oid_s, 1)[0])
                pvid = int(val)
            except (ValueError, IndexError):
                continue
            ifindex = bridge_to_ifindex.get(bp)
            if ifindex is not None and ifindex in sw.interfaces:
                sw.interfaces[ifindex].vlan = pvid

        # -- 6b. Tagged VLANs (dot1qVlanStaticEgressPorts / UntaggedPorts) ----
        try:
            egress_rows, untagged_rows = await asyncio.gather(
                snmp_bulk_walk_raw(
                    ip, snmp_port, auth, OID_DOT1Q_VLAN_STATIC_EGRESS,
                    timeout=snmp_timeout, retries=snmp_retries, engine=engine,
                ),
                snmp_bulk_walk_raw(
                    ip, snmp_port, auth, OID_DOT1Q_VLAN_STATIC_UNTAGGED,
                    timeout=snmp_timeout, retries=snmp_retries, engine=engine,
                ),
            )

            if egress_rows:
                # Build per-VLAN sets: {vlan_id: set of bridge ports}
                egress_by_vlan = {}
                for oid_s, raw_val in egress_rows:
                    try:
                        vlan_id = int(_last_n(oid_s, 1)[0])
                    except (ValueError, IndexError):
                        continue
                    egress_by_vlan[vlan_id] = parse_port_bitmask(raw_val)

                untagged_by_vlan = {}
                for oid_s, raw_val in untagged_rows:
                    try:
                        vlan_id = int(_last_n(oid_s, 1)[0])
                    except (ValueError, IndexError):
                        continue
                    untagged_by_vlan[vlan_id] = parse_port_bitmask(raw_val)

                # Compute tagged VLANs per bridge port, then map to ifIndex
                # tagged = egress - untagged
                tagged_by_bp = {}  # bridge_port -> list of tagged VLAN IDs
                for vlan_id, egress_ports in egress_by_vlan.items():
                    untagged_ports = untagged_by_vlan.get(vlan_id, set())
                    tagged_ports = egress_ports - untagged_ports
                    for bp in tagged_ports:
                        tagged_by_bp.setdefault(bp, []).append(vlan_id)

                for bp, vlans in tagged_by_bp.items():
                    ifindex = bridge_to_ifindex.get(bp)
                    if ifindex is not None and ifindex in sw.interfaces:
                        sw.interfaces[ifindex].tagged_vlans = sorted(vlans)

                log.debug("Tagged VLANs for %s: %d ports have tagged VLANs",
                          ip, len(tagged_by_bp))
        except Exception:
            log.debug("Tagged VLAN walk failed for %s (static egress tables not supported)", ip)

    except Exception:
        log.debug("VLAN walk failed for %s (Q-BRIDGE-MIB not supported)", ip)
```

Key design decisions:
- The two bitmask walks (`egress` and `untagged`) are done in parallel via `asyncio.gather` for performance.
- Tagged VLANs = `EgressPorts - UntaggedPorts` (set difference) per VLAN.
- The tagged VLAN walk is wrapped in its own `try/except` so failure does not break the existing PVID walk.
- Results are sorted for consistent display.

- [x] Task 5.1: Add parallel `snmp_bulk_walk_raw` calls for egress and untagged OIDs
- [x] Task 5.2: Parse bitmasks and compute per-port tagged VLANs
- [x] Task 5.3: Map bridge ports to ifIndex and store in `iface.tagged_vlans`
- [x] Task 5.4: Wrap in try/except for graceful fallback

---

### Step 6: Backend - database.py - Add tagged_vlans Column

**File:** `backend/database.py`
**Location:** Line ~213, inside the `Port` class, after the `vlan` column

```python
# BEFORE (lines 211-213):
    vlan         = Column(Integer, default=0)

    device = relationship("Device", back_populates="ports")

# AFTER:
    vlan         = Column(Integer, default=0)
    tagged_vlans = Column(JSONB, default=list)

    device = relationship("Device", back_populates="ports")
```

- [x] Task 6.1: Add `tagged_vlans = Column(JSONB, default=list)` to Port model

---

### Step 7: Backend - Alembic Migration 011

**File:** `backend/alembic/versions/011_add_tagged_vlans.py` (NEW)

```python
"""Add tagged_vlans JSONB column to ports table.

Revision ID: 011
Revises: 010
Create Date: 2026-03-09

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ports", sa.Column("tagged_vlans", JSONB, server_default="[]", nullable=True))


def downgrade() -> None:
    op.drop_column("ports", "tagged_vlans")
```

- [x] Task 7.1: Create migration file `011_add_tagged_vlans.py`

---

### Step 8: Backend - scan_engine.py - Store tagged_vlans in Port Record

**File:** `backend/scan_engine.py`
**Location:** Line ~941, inside the `port_rows.append({...})` block

```python
# BEFORE (lines 929-942):
                        port_rows.append({
                            "device_id": device.id,
                            "if_index": iface.index,
                            "if_descr": iface.descr,
                            "if_alias": iface.alias,
                            "speed_mbps": iface.speed_mbps,
                            "oper_status": iface.oper_status,
                            "peer_mac": peer_mac,
                            "peer_ip": peer_ip,
                            "peer_host": peer_host,
                            "endpoint_count": len(endpoint_details),
                            "endpoint_details_json": endpoint_details,
                            "vlan": iface.vlan,
                        })

# AFTER:
                        port_rows.append({
                            "device_id": device.id,
                            "if_index": iface.index,
                            "if_descr": iface.descr,
                            "if_alias": iface.alias,
                            "speed_mbps": iface.speed_mbps,
                            "oper_status": iface.oper_status,
                            "peer_mac": peer_mac,
                            "peer_ip": peer_ip,
                            "peer_host": peer_host,
                            "endpoint_count": len(endpoint_details),
                            "endpoint_details_json": endpoint_details,
                            "vlan": iface.vlan,
                            "tagged_vlans": iface.tagged_vlans,
                        })
```

- [x] Task 8.1: Add `"tagged_vlans": iface.tagged_vlans` to `port_rows.append()`

---

### Step 9: Backend - schemas.py - Add tagged_vlans to PortOut

**File:** `backend/schemas.py`
**Location:** Lines 288-320 (`PortOut` class)

Two changes needed:

**9a.** Add the field (after `vlan` field at line ~300):

```python
# BEFORE (line ~300):
    vlan:        Optional[int] = 0

    @model_validator(mode="before")

# AFTER:
    vlan:        Optional[int] = 0
    tagged_vlans: Optional[list] = []

    @model_validator(mode="before")
```

**9b.** Add to `_coerce_nulls` defaults dict (line ~308):

```python
# BEFORE (lines 305-310):
            defaults = {
                "if_index": 0, "if_descr": "", "if_alias": "", "speed_mbps": 0,
                "oper_status": 0, "peer_mac": "", "peer_ip": "", "peer_host": "",
                "endpoint_count": 0, "endpoint_details_json": [], "vlan": 0,
            }

# AFTER:
            defaults = {
                "if_index": 0, "if_descr": "", "if_alias": "", "speed_mbps": 0,
                "oper_status": 0, "peer_mac": "", "peer_ip": "", "peer_host": "",
                "endpoint_count": 0, "endpoint_details_json": [], "vlan": 0,
                "tagged_vlans": [],
            }
```

- [x] Task 9.1: Add `tagged_vlans: Optional[list] = []` field to `PortOut`
- [x] Task 9.2: Add `"tagged_vlans": []` to `_coerce_nulls` defaults

---

### Step 10: Frontend - Port.jsx - Display Tagged VLANs in Tooltip

**File:** `frontend/src/components/Port.jsx`
**Location:** Line ~146 (the VLAN display in the tooltip grid)

Replace the single VLAN display with a combined native + tagged display:

```jsx
// BEFORE (line ~146):
              {port.vlan > 0 && <><span style={{color:"#475569"}}>VLAN</span><span>{port.vlan}</span></>}

// AFTER:
              {port.vlan > 0 && <><span style={{color:"#475569"}}>VLAN</span><span>{port.vlan}{port.tagged_vlans && port.tagged_vlans.length > 0 && ` (tagged: ${port.tagged_vlans.join(", ")})`}</span></>}
```

This renders as:
- Native VLAN only: `VLAN  1`
- Native + tagged: `VLAN  1 (tagged: 10, 40)`

- [x] Task 10.1: Update VLAN tooltip display in `Port.jsx`

---

### Step 11: Frontend - PortDetailModal.jsx - Display Tagged VLANs in Detail Modal

**File:** `frontend/src/components/PortDetailModal.jsx`
**Location:** Lines 87-89 (the VLAN display in the metadata grid)

```jsx
// BEFORE (lines 87-89):
          {port.vlan > 0 && <>
            <span style={{ color: "#475569" }}>VLAN</span>
            <span>{port.vlan}</span>
          </>}

// AFTER:
          {port.vlan > 0 && <>
            <span style={{ color: "#475569" }}>VLAN</span>
            <span>{port.vlan}</span>
          </>}
          {port.tagged_vlans && port.tagged_vlans.length > 0 && <>
            <span style={{ color: "#475569" }}>Tagged</span>
            <span>{port.tagged_vlans.join(", ")}</span>
          </>}
```

This adds a separate "Tagged" row in the detail modal showing the tagged VLAN list.

- [x] Task 11.1: Add tagged VLANs row in `PortDetailModal.jsx` metadata grid

---

## File Change Summary

| # | File | Action | Description |
|---|------|--------|-------------|
| 1 | `backend/snmp_scanner.py` | Edit | Add 2 OID constants after line 116 |
| 2 | `backend/snmp_scanner.py` | Edit | Add `snmp_bulk_walk_raw()` function after line ~315 |
| 3 | `backend/snmp_scanner.py` | Edit | Add `parse_port_bitmask()` helper after `snmp_bulk_walk_raw()` |
| 4 | `backend/snmp_scanner.py` | Edit | Add `tagged_vlans` field to `IfInfo` dataclass at line ~141 |
| 5 | `backend/snmp_scanner.py` | Edit | Extend step 6 VLAN block (lines 706-740) with tagged VLAN walks |
| 6 | `backend/database.py` | Edit | Add `tagged_vlans` JSONB column to Port model at line ~213 |
| 7 | `backend/alembic/versions/011_add_tagged_vlans.py` | Create | New migration adding `tagged_vlans` column |
| 8 | `backend/scan_engine.py` | Edit | Add `tagged_vlans` to port_rows dict at line ~941 |
| 9 | `backend/schemas.py` | Edit | Add `tagged_vlans` to PortOut + _coerce_nulls at lines ~300, ~308 |
| 10 | `frontend/src/components/Port.jsx` | Edit | Update VLAN tooltip at line ~146 |
| 11 | `frontend/src/components/PortDetailModal.jsx` | Edit | Add tagged VLANs row at line ~89 |

---

## Testing Notes

1. **SNMP scanner**: Test with a switch known to support Q-BRIDGE-MIB static egress tables. Verify `tagged_vlans` is populated in `IfInfo` after scan.
2. **Fallback**: Test with a switch that does NOT support static egress tables. Verify the scan completes without errors and `tagged_vlans` remains empty.
3. **Database**: Run `alembic upgrade head` and verify the new column exists.
4. **API**: Hit `/api/topology` and verify `tagged_vlans` appears in port objects.
5. **Frontend**: Verify tooltip shows "VLAN 1 (tagged: 10, 40)" format. Verify detail modal shows separate "Tagged" row.

---

## Backward Compatibility

- `tagged_vlans` defaults to `[]` everywhere (dataclass, DB column, schema, frontend checks).
- Existing `vlan` field (native VLAN) is unchanged.
- Switches that don't support tagged VLAN OIDs will gracefully fall back to empty list.
- No API breaking changes -- `tagged_vlans` is additive.
