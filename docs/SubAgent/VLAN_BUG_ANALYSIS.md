# VLAN Bug Analysis - All Ports Show "VLAN 1"

## Problem Statement

Users with UniFi switches report that all ports display "VLAN 1" even though different VLANs are assigned.

---

## Complete Data Flow

### 1. SNMP Collection (snmp_scanner.py)

**OID defined at line 116:**
```python
OID_DOT1Q_PVID = "1.3.6.1.2.1.17.7.1.4.5.1.1"  # dot1qPvid
```

**IfInfo dataclass (line 140-146)** stores `vlan: int = 0` per interface.

**VLAN collection logic (lines 706-735):**
```python
# -- 6. VLAN (dot1qPvid) - fault-tolerant --------------------------------
try:
    if not bridge_to_ifindex:
        bp_rows = await snmp_bulk_walk(...)  # OID_DOT1D_BASE_PORT_IF_INDEX
        for oid_s, ifindex_val in bp_rows:
            bp = int(_last_n(oid_s, 1)[0])
            bridge_to_ifindex[bp] = int(ifindex_val)

    pvid_rows = await snmp_bulk_walk(
        ip, snmp_port, auth, OID_DOT1Q_PVID, ...
    )
    for oid_s, val in pvid_rows:
        bp = int(_last_n(oid_s, 1)[0])       # <-- extracts bridge port number
        pvid = int(val)
        ifindex = bridge_to_ifindex.get(bp)   # <-- maps bridge port -> ifIndex
        if ifindex is not None and ifindex in sw.interfaces:
            sw.interfaces[ifindex].vlan = pvid
except Exception:
    log.debug("VLAN walk failed for %s (Q-BRIDGE-MIB not supported)", ip)
```

### 2. Database Storage (database.py, line ~207)

```python
class Port(Base):
    vlan = Column(Integer, default=0)
```

### 3. Scan Engine Persistence (scan_engine.py, line 941)

```python
port_rows.append({
    ...
    "vlan": iface.vlan,
})
```

### 4. API Schema (schemas.py, line 300)

```python
class PortOut(BaseModel):
    vlan: Optional[int] = 0
```

### 5. Frontend Display (Port.jsx line 146, PortDetailModal.jsx lines 87-89)

```jsx
{port.vlan > 0 && <><span>VLAN</span><span>{port.vlan}</span></>}
```

---

## ROOT CAUSE ANALYSIS

### The Problem: Bridge Port to ifIndex Mapping Failure

The `dot1qPvid` OID (`1.3.6.1.2.1.17.7.1.4.5.1.1`) is indexed by **bridge port number**, not by ifIndex. The code correctly attempts to translate via `bridge_to_ifindex` (populated from `OID_DOT1D_BASE_PORT_IF_INDEX = 1.3.6.1.2.1.17.1.4.1.2`).

**The likely failure point on UniFi switches:**

1. **`bridge_to_ifindex` may be empty.** UniFi switches may not populate `dot1dBasePortIfIndex` (OID `1.3.6.1.2.1.17.1.4.1.2`), or the walk may return zero rows. When `bridge_to_ifindex` is empty, `bridge_to_ifindex.get(bp)` returns `None` for every bridge port, so NO VLAN data gets assigned to any interface.

2. **Bridge port == ifIndex identity on UniFi.** On many UniFi switches, the bridge port number IS the ifIndex (1:1 mapping). The code does NOT have a fallback for this case. It silently drops all VLAN data when the mapping table is empty.

3. **Silent exception swallowing.** The entire VLAN section is wrapped in a bare `except Exception` that only logs at DEBUG level. If `dot1dBasePortIfIndex` or `dot1qPvid` walks fail or return unexpected data, the error is completely hidden.

### Why "VLAN 1" appears everywhere

If the scenario above is correct (empty `bridge_to_ifindex`), then `iface.vlan` stays at its default value of `0` for all interfaces. The database stores `vlan=0`.

**BUT** - the user says they see "VLAN 1", not no VLAN. This means either:
- (a) The `dot1qPvid` walk works but returns correct data (PVID=1 for untagged ports is normal - this IS the default PVID), and the real issue is that **tagged/trunk VLANs are not being collected at all** (dot1qPvid only returns the PVID - the native/untagged VLAN), OR
- (b) The bridge_to_ifindex mapping partially works but maps incorrectly, causing only VLAN 1 ports to match.

### Most Likely Root Cause: dot1qPvid Only Returns the PVID (Native VLAN)

**This is the most probable cause.** The `dot1qPvid` OID only returns the **Port VLAN ID (PVID)** - the VLAN assigned to untagged traffic. On most UniFi configurations:
- Access ports get their configured VLAN as PVID (should show correctly)
- Trunk ports get PVID=1 (the native VLAN)

If the user has configured ports as **trunk ports** (carrying multiple tagged VLANs), the PVID will be 1 (default native VLAN) even though the port carries VLANs 10, 20, 30, etc. as tagged traffic. The code has **no mechanism to collect tagged VLAN membership**.

However, if the user has configured **access ports** with specific VLANs and still sees VLAN 1, then the issue is the bridge_to_ifindex mapping failure described above.

### Secondary Issue: No Debug Logging for Diagnosis

There is no logging showing:
- How many `pvid_rows` were returned
- How many `bridge_to_ifindex` entries exist
- How many VLANs were actually mapped to interfaces
- Whether any bridge ports couldn't be mapped

---

## Key Files and Line Numbers

| File | Lines | What |
|------|-------|------|
| `backend/snmp_scanner.py` | 116 | `OID_DOT1Q_PVID` definition |
| `backend/snmp_scanner.py` | 140-146 | `IfInfo` dataclass with `vlan: int = 0` |
| `backend/snmp_scanner.py` | 706-735 | VLAN collection logic (step 6) - **THE BUG IS HERE** |
| `backend/snmp_scanner.py` | 95-96 | `OID_DOT1D_BASE_PORT_IF_INDEX` for bridge-to-if mapping |
| `backend/scan_engine.py` | 941 | Where `iface.vlan` is written to DB |
| `backend/database.py` | ~207 | `Port.vlan` column definition |
| `backend/schemas.py` | 300 | `PortOut.vlan` API field |
| `backend/scanners/unifi.py` | 1-26 | UniFi scanner - has NO VLAN-specific logic |
| `frontend/src/components/Port.jsx` | 146 | VLAN display in port component |

---

## Recommended Fix

### Fix 1: Add identity fallback when bridge_to_ifindex is empty (snmp_scanner.py ~line 730)

After the `pvid_rows` walk, if `bridge_to_ifindex` is empty, try using the bridge port number directly as ifIndex:

```python
for oid_s, val in pvid_rows:
    bp = int(_last_n(oid_s, 1)[0])
    pvid = int(val)
    ifindex = bridge_to_ifindex.get(bp, bp)  # fallback: bp == ifindex
    if ifindex in sw.interfaces:
        sw.interfaces[ifindex].vlan = pvid
```

### Fix 2: Add diagnostic logging

Add logging to show how many PVID rows were received and how many were successfully mapped.

### Fix 3 (optional): Collect tagged VLAN membership

To show all VLANs on trunk ports (not just PVID), walk `dot1qVlanCurrentEgressPorts` (OID `1.3.6.1.2.1.17.7.1.4.2.1.4`) which returns a bitmap of ports per VLAN. This is a larger enhancement.

---

## Vendor Scanner Comparison

| Scanner | File | fdb_strategy | VLAN-specific logic |
|---------|------|--------------|-------------------|
| UniFi | scanners/unifi.py | `qbridge` | NONE |
| Aruba CX | scanners/aruba_cx.py | `dot1d` | NONE |
| FS | scanners/fs_scanner.py | `dot1d` | NONE |
| Generic | scanners/generic.py | `dot1d` | NONE |

No vendor scanner has any VLAN-specific logic. All VLAN collection is handled centrally in `snmp_scanner.py` step 6. The vendor scanners only control FDB strategy, model extraction, and virtual port filtering.
