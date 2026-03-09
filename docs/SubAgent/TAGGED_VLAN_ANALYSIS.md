# Tagged VLAN Collection - Analysis

## 1. Current VLAN Data Flow

### SNMP Collection (snmp_scanner.py)

The VLAN data collection happens in **step 6** of `_scan_switch_inner()` (lines ~707-740):

1. If `bridge_to_ifindex` was not populated during the MAC walk (step 5), a separate walk of `OID_DOT1D_BASE_PORT_IF_INDEX` (`1.3.6.1.2.1.17.1.4.1.2`) is performed to build the bridge-port-to-ifIndex mapping.
2. A single SNMP BULK WALK of `OID_DOT1Q_PVID` (`1.3.6.1.2.1.17.7.1.4.5.1.1`) is performed. This OID returns the **native/untagged VLAN** per bridge port.
3. For each PVID row, the bridge port number is extracted from the OID suffix, mapped to an ifIndex via `bridge_to_ifindex`, and stored as `sw.interfaces[ifindex].vlan = pvid` (a single integer).

### IfInfo Dataclass (snmp_scanner.py, line ~141)

```python
@dataclass
class IfInfo:
    index:       int
    descr:       str = ""
    alias:       str = ""
    speed_mbps:  int = 0
    oper_status: int = 2
    vlan:        int = 0        # Single integer - native VLAN only
```

### Scan Engine Persistence (scan_engine.py, line ~941)

In `_execute_scan()`, when persisting ports to the database, each port row is built from the `IfInfo` object:

```python
port_rows.append({
    ...
    "vlan": iface.vlan,     # Single integer written to DB
})
```

### Database Model (database.py, line ~192)

```python
class Port(Base):
    __tablename__ = "ports"
    ...
    vlan = Column(Integer, default=0)    # Single integer column
```

### API Schema (schemas.py, lines ~288-320)

```python
class PortOut(BaseModel):
    ...
    vlan: Optional[int] = 0    # Single integer in JSON response
```

The `_coerce_nulls` validator defaults `vlan` to `0` if None.

### API Response (routers/topology.py)

The `/api/topology` endpoint returns `DeviceOut` objects which contain `List[PortOut]`. Port data flows through SQLAlchemy's lazy="selectin" loading on `Device.ports`, then serialized via `PortOut` schema. No VLAN-specific transformation happens in the router.

### Frontend Display

Two components display VLAN:

1. **Port.jsx** (line 146) - Tooltip on hover:
   ```jsx
   {port.vlan > 0 && <><span style={{color:"#475569"}}>VLAN</span><span>{port.vlan}</span></>}
   ```

2. **PortDetailModal.jsx** (lines 87-89) - Detail modal:
   ```jsx
   {port.vlan > 0 && <>
     <span style={{ color: "#475569" }}>VLAN</span>
     <span>{port.vlan}</span>
   </>}
   ```

Both check `port.vlan > 0` and display a single number.

---

## 2. SNMP Approach for Tagged VLANs

### Relevant Q-BRIDGE-MIB OIDs

| OID | Name | Description |
|-----|------|-------------|
| `1.3.6.1.2.1.17.7.1.4.5.1.1` | `dot1qPvid` | Native/untagged VLAN per bridge port (already collected) |
| `1.3.6.1.2.1.17.7.1.4.2.1.4` | `dot1qVlanCurrentEgressPorts` | Current egress port bitmask per VLAN (dynamic, includes learned) |
| `1.3.6.1.2.1.17.7.1.4.3.1.2` | `dot1qVlanStaticEgressPorts` | Statically configured egress ports per VLAN |
| `1.3.6.1.2.1.17.7.1.4.3.1.4` | `dot1qVlanStaticUntaggedPorts` | Untagged ports per VLAN (ports that strip the tag on egress) |

### Recommended Strategy

Use `dot1qVlanStaticEgressPorts` and `dot1qVlanStaticUntaggedPorts`:

1. Walk `dot1qVlanStaticEgressPorts` (OID `1.3.6.1.2.1.17.7.1.4.3.1.2`)
   - Index: VLAN ID
   - Value: `OCTET STRING` bitmask where each bit represents a bridge port number
   - Bit position N (1-indexed) = bridge port N
   - A set bit means the VLAN is configured on that port (egress allowed)

2. Walk `dot1qVlanStaticUntaggedPorts` (OID `1.3.6.1.2.1.17.7.1.4.3.1.4`)
   - Same index and bitmask format
   - A set bit means the port sends traffic for this VLAN **untagged**

3. For each port:
   - If port appears in `StaticEgressPorts` but NOT in `StaticUntaggedPorts` for a given VLAN -> port is **tagged** for that VLAN
   - If port appears in both -> port is **untagged** for that VLAN (this matches the PVID)
   - The PVID from `dot1qPvid` should match the untagged VLAN

### Bitmask Parsing

The `OCTET STRING` value from `dot1qVlanStaticEgressPorts` is a byte array where:
- Byte 0, bit 7 (MSB) = bridge port 1
- Byte 0, bit 6 = bridge port 2
- ...
- Byte 0, bit 0 = bridge port 8
- Byte 1, bit 7 = bridge port 9
- etc.

In Python:
```python
def parse_port_bitmask(octet_string_bytes: bytes) -> set[int]:
    """Parse Q-BRIDGE port bitmask into set of bridge port numbers (1-indexed)."""
    ports = set()
    for byte_idx, byte_val in enumerate(octet_string_bytes):
        for bit in range(8):
            if byte_val & (0x80 >> bit):
                ports.add(byte_idx * 8 + bit + 1)
    return ports
```

**Important**: The bitmask values are `OCTET STRING` (binary), which means `_decode_snmp_str()` should NOT be used for these. The raw `bytes()` value from the pysnmp response must be used directly. The existing `snmp_bulk_walk()` function calls `_decode_snmp_str()` on all values, which will corrupt binary bitmask data. A new walk variant or a raw-value parameter is needed.

### Fallback to Current EgressPorts

If `dot1qVlanStaticEgressPorts` returns empty results (some switches may not support static tables), fall back to `dot1qVlanCurrentEgressPorts` (`1.3.6.1.2.1.17.7.1.4.2.1.4`). Note: This OID has a 2-part index `(TimeMark, VlanIndex)` where TimeMark is typically 0.

---

## 3. What Needs to Change at Each Layer

### Layer 1: SNMP Scanner (snmp_scanner.py)

1. **Add new OID constants**:
   ```python
   OID_DOT1Q_VLAN_STATIC_EGRESS    = "1.3.6.1.2.1.17.7.1.4.3.1.2"
   OID_DOT1Q_VLAN_STATIC_UNTAGGED  = "1.3.6.1.2.1.17.7.1.4.3.1.4"
   OID_DOT1Q_VLAN_CURRENT_EGRESS   = "1.3.6.1.2.1.17.7.1.4.2.1.4"
   ```

2. **Add a raw-bytes bulk walk helper** (or modify `snmp_bulk_walk`):
   The existing `snmp_bulk_walk` decodes all values to strings via `_decode_snmp_str()`. For bitmask OIDs, raw bytes are needed. Options:
   - Add a `raw=True` parameter to `snmp_bulk_walk` that returns `(oid_str, bytes)` tuples
   - Create a separate `snmp_bulk_walk_raw()` function

3. **Add bitmask parser function**: `parse_port_bitmask(raw_bytes) -> set[int]`

4. **Extend IfInfo dataclass**:
   ```python
   @dataclass
   class IfInfo:
       ...
       vlan:        int = 0              # Native/PVID (kept for backward compat)
       tagged_vlans: List[int] = field(default_factory=list)  # Tagged VLANs on this port
   ```

5. **Extend step 6** in `_scan_switch_inner()`:
   - After the existing PVID walk, perform two additional walks for `dot1qVlanStaticEgressPorts` and `dot1qVlanStaticUntaggedPorts`
   - Parse bitmasks, build per-port tagged VLAN lists
   - Store in `iface.tagged_vlans`

### Layer 2: Database Model (database.py)

Change the Port model to store multiple VLANs. Options:

**Option A: JSONB column (recommended)**
```python
class Port(Base):
    ...
    vlan = Column(Integer, default=0)              # Keep: native VLAN (PVID)
    tagged_vlans = Column(JSONB, default=list)      # New: list of tagged VLAN IDs
```
- Pros: No schema change to existing `vlan` column, backward compatible, flexible
- Cons: Cannot index individual VLAN values efficiently (not needed for this use case)

**Option B: Comma-separated string**
```python
    tagged_vlans = Column(String, default="")      # "10,20,40"
```
- Pros: Simple
- Cons: Needs parse/format logic, less clean

**Recommendation**: Option A (JSONB). The project already uses JSONB for `endpoint_details_json`.

### Layer 3: Alembic Migration

- Latest migration: **010** (`010_dry_run_cascade.py`)
- New migration: **011_add_tagged_vlans.py**
- Add `tagged_vlans` column (JSONB, default `[]`) to `ports` table

### Layer 4: Scan Engine (scan_engine.py)

Update port row construction (line ~941):
```python
port_rows.append({
    ...
    "vlan": iface.vlan,
    "tagged_vlans": iface.tagged_vlans,   # New field
})
```

### Layer 5: API Schema (schemas.py)

Update `PortOut`:
```python
class PortOut(BaseModel):
    ...
    vlan:         Optional[int] = 0
    tagged_vlans: Optional[list] = []     # New field
```

Update `_coerce_nulls` defaults:
```python
defaults = {
    ...
    "vlan": 0,
    "tagged_vlans": [],
}
```

### Layer 6: Frontend

**Port.jsx** (line 146) - Update tooltip to show all VLANs:
```jsx
// Instead of just port.vlan, show combined VLAN info
{(port.vlan > 0 || (port.tagged_vlans && port.tagged_vlans.length > 0)) && (
  <><span style={{color:"#475569"}}>VLAN</span>
  <span>{formatVlans(port.vlan, port.tagged_vlans)}</span></>
)}
```

**PortDetailModal.jsx** (lines 87-89) - Same update in the detail grid.

A helper function to format the display:
```js
function formatVlans(pvid, taggedVlans) {
  const all = new Set();
  if (pvid > 0) all.add(pvid);
  if (taggedVlans) taggedVlans.forEach(v => all.add(v));
  return [...all].sort((a, b) => a - b).join(", ");
}
```

---

## 4. How to Distinguish Tagged vs Untagged

For each VLAN ID discovered:
- Walk `dot1qVlanStaticEgressPorts`: gives set of ports that **egress** this VLAN (both tagged and untagged)
- Walk `dot1qVlanStaticUntaggedPorts`: gives set of ports that egress this VLAN **untagged**
- **Tagged ports** = `EgressPorts - UntaggedPorts` (set difference)
- **Untagged/native port** = already captured by `dot1qPvid`

The `tagged_vlans` field should contain only the **tagged** VLANs (excluding the native VLAN), since the native VLAN is already stored in `vlan`.

---

## 5. Current Migration Numbering

| Migration | Description |
|-----------|-------------|
| 001 | Initial schema |
| 002 | Add device ignored |
| 003 | Add cascade deletes |
| 003b | Add switch_class allow_outside_rack |
| 004 | JSONB snapshot columns |
| 005 | Settings to DB |
| 006 | Add users table |
| 007 | Add audit log |
| 008 | Credential fallback |
| 009 | Dry run results |
| 010 | Dry run cascade |

**Next migration number: 011**

---

## 6. Frontend Files Referencing VLAN

| File | Line(s) | Usage |
|------|---------|-------|
| `frontend/src/components/Port.jsx` | 146 | Tooltip: `{port.vlan > 0 && ...}` shows single VLAN number |
| `frontend/src/components/PortDetailModal.jsx` | 87-89 | Detail modal: `{port.vlan > 0 && ...}` shows single VLAN number |

No other frontend files reference VLAN data.

---

## 7. Key Implementation Risks & Considerations

1. **Binary bitmask handling**: The existing `snmp_bulk_walk()` decodes all values via `_decode_snmp_str()`, which corrupts binary OCTET STRING data (bitmasks). A raw-bytes variant is essential. The pysnmp `OctetString` type can be converted to `bytes()` directly - the `_decode_snmp_str()` function already does `raw: bytes = bytes(val)` but then decodes to a string. The raw walk needs to return these bytes before string conversion.

2. **Bridge port numbering**: The bitmask positions correspond to **bridge port numbers** (not ifIndex). The existing `bridge_to_ifindex` mapping (from `dot1dBasePortIfIndex`) is needed to convert bridge ports to ifIndex values.

3. **Vendor compatibility**: Not all switches support Q-BRIDGE-MIB static egress tables. The walk should be fault-tolerant (wrapped in try/except, like the existing PVID walk). If static tables return nothing, optionally fall back to `dot1qVlanCurrentEgressPorts`.

4. **Performance**: Two additional SNMP walks per switch. These can be done in parallel with each other (via `asyncio.gather`), and potentially in parallel with the existing PVID walk.

5. **VLAN 1 filtering**: Many switches tag all ports with VLAN 1 as default. Consider whether to filter out VLAN 1 from `tagged_vlans` when it matches the PVID, to avoid clutter in the UI.

6. **Large VLAN sets**: Trunk ports may carry many VLANs (e.g., 50+). The frontend display should handle this gracefully (truncation or expandable list).
