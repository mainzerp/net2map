# Endpoint Data Flow Analysis: SNMP Scan to Port Tooltip

## Summary

The full pipeline from SNMP scanning through database persistence to the `/api/topology` endpoint is **correctly wired**. The schema, scan engine, and API all support endpoint data. The most likely reason for empty fields (`peer_ip=""`, `peer_mac=""`, `endpoint_count=0`) is that **the SNMP ARP/FDB walks return no data** from the target switches, or that the **ARP-to-FDB join fails** due to MAC address format mismatches or missing bridge-port-to-ifIndex mappings.

---

## 1. SNMP Scanner (`backend/snmp_scanner.py`)

### OID Constants Defined

| OID Constant | OID Value | MIB | Purpose |
|---|---|---|---|
| `OID_ARP_MAC` | `1.3.6.1.2.1.4.22.1.2` | IP-MIB (legacy ARP) | MAC address from ARP cache |
| `OID_ARP_IP` | `1.3.6.1.2.1.4.22.1.3` | IP-MIB (legacy ARP) | IP address from ARP cache |
| `OID_DOT1D_TP_FDB_PORT` | `1.3.6.1.2.1.17.4.3.1.2` | BRIDGE-MIB | MAC -> bridge port (dot1d strategy) |
| `OID_DOT1D_BASE_PORT_IF_INDEX` | `1.3.6.1.2.1.17.1.4.1.2` | BRIDGE-MIB | Bridge port -> ifIndex mapping |
| `OID_QBRIDGE_FDB_PORT` | `1.3.6.1.2.1.17.7.1.2.2.1.2` | Q-BRIDGE-MIB | MAC+VLAN -> bridge port (qbridge strategy) |
| `OID_QBRIDGE_FDB_STATUS` | `1.3.6.1.2.1.17.7.1.2.2.1.3` | Q-BRIDGE-MIB | FDB entry status (3=learned) |
| `OID_IP_NET_TO_PHYSICAL_MAC` | `1.3.6.1.2.1.4.35.1.4` | IP-MIB (unified) | ipNetToPhysicalPhysAddress |
| `OID_IP_NET_TO_PHYSICAL_ADDR` | `1.3.6.1.2.1.4.35.1.3` | IP-MIB (unified) | ipNetToPhysicalNetAddress |

### SwitchData Dataclass

Holds two key dictionaries populated during scan:
- `arp_table: Dict[str, str]` -- maps MAC -> IP (from ARP walk)
- `mac_ifindex: Dict[str, int]` -- maps MAC -> ifIndex (from BRIDGE-MIB/Q-BRIDGE FDB walk)

### MAC/ARP Collection Logic (Step 5 in `_scan_switch_inner`)

Only runs when `wants_macs = True`, which is true for scan modes: `full`, `ports`, `macs`.

1. **Parallel SNMP walks** for 4 OID trees:
   - `OID_ARP_MAC` - ARP MAC addresses
   - `OID_ARP_IP` - ARP IP addresses  
   - `OID_DOT1D_BASE_PORT_IF_INDEX` - bridge port to ifIndex mapping
   - Vendor-specific FDB OID (dot1d or qbridge based on `scanner.fdb_strategy()`)

2. **ARP table construction**: Correlates `OID_ARP_IP` and `OID_ARP_MAC` rows by OID suffix (last 5 components) to build `sw.arp_table[mac] = ip`.

3. **Bridge-to-ifIndex mapping**: Walks `OID_DOT1D_BASE_PORT_IF_INDEX` to build `bridge_to_ifindex[bridge_port] = ifindex`.

4. **FDB table construction**: Parses FDB walk results using `_oid_to_mac()` (dot1d) or `_oid_to_mac_qbridge()` (qbridge). For each MAC entry, looks up the bridge port in `bridge_to_ifindex` to resolve the final ifIndex, storing in `sw.mac_ifindex[mac] = ifindex`.

### Vendor FDB Strategies

| Vendor | FDB Strategy | FDB OID Used |
|---|---|---|
| Aruba CX | `dot1d` | `OID_DOT1D_TP_FDB_PORT` (.1.3.6.1.2.1.17.4.3.1.2) |
| FS.COM | `dot1d` | `OID_DOT1D_TP_FDB_PORT` |
| UniFi | `qbridge` | `OID_QBRIDGE_FDB_PORT` (.1.3.6.1.2.1.17.7.1.2.2.1.2) |
| OPNsense | `dot1d` | `OID_DOT1D_TP_FDB_PORT` |
| Generic | `dot1d` | `OID_DOT1D_TP_FDB_PORT` |

### Critical Join Logic

To associate a MAC/IP with a port, a MAC must appear in **both**:
1. `sw.arp_table` (MAC -> IP from ARP)
2. `sw.mac_ifindex` (MAC -> ifIndex from FDB + bridge port mapping)

If a MAC is only in the FDB table but not in the ARP table, there is no IP to associate. If a MAC is only in the ARP table but not the FDB table, there is no interface to associate it with.

---

## 2. Database Schema (`backend/database.py`)

### Port Model

The `Port` table has all required columns:

```python
class Port(Base):
    __tablename__ = "ports"
    peer_mac     = Column(String, default="")
    peer_ip      = Column(String, default="")
    peer_host    = Column(String, default="")
    endpoint_count = Column(Integer, default=0)
    endpoint_details_json = Column(JSONB, default=[])
    vlan         = Column(Integer, default=0)
```

**No separate endpoint table exists.** All endpoint data is stored directly on the `Port` row, with `endpoint_details_json` (JSONB) holding a list of `{"mac", "ip", "host"}` objects for multi-endpoint ports.

### Migration History

- **001**: Created columns as `String`/`Text`/`Integer`
- **004**: Converted `endpoint_details_json` from `Text` to `JSONB`

---

## 3. Scan Engine Persistence (`backend/scan_engine.py`, lines 820-893)

### Port Update Logic

Controlled by: `update_ports = scan_mode in {"full", "ports", "macs"}`

For each device's `SwitchData`:

1. **Builds `peers_by_ifindex` dict**: Iterates `sw.arp_table` (MAC -> IP), looks up each MAC in `sw.mac_ifindex` to get `ifindex`. If both exist, resolves hostname via DNS and stores `(mac, ip, host)` tuple grouped by ifindex.

2. **Deletes all existing ports** for the device (`db.query(Port).filter(...).delete()`).

3. **Creates new Port rows**: For each physical interface, checks if `peers_by_ifindex[iface.index]` has entries. If so:
   - `peer_mac`, `peer_ip`, `peer_host` = first entry (sorted by IP)
   - `endpoint_count` = total entries
   - `endpoint_details_json` = `json.dumps([{"mac":..., "ip":..., "host":...}, ...])`

4. **Bulk inserts** all port rows.

### Potential Issue: JSONB Column with json.dumps()

Line 882: `"endpoint_details_json": json.dumps(endpoint_details)` passes a **string** to a **JSONB column**. SQLAlchemy + psycopg2 with PostgreSQL JSONB will accept a JSON string and deserialize it correctly. However, when read back, the value will be a Python list (not a string). The `PortOut` schema declares `endpoint_details_json: Optional[str] = "[]"`, so Pydantic serialization will call `str()` on the list if it's not already a string. This works in practice but is not ideal; the schema coerces `None` to `"[]"` via `_coerce_nulls`.

---

## 4. Pydantic Schemas (`backend/schemas.py`)

### PortOut Schema (line 286)

```python
class PortOut(BaseModel):
    peer_mac:    Optional[str] = ""
    peer_ip:     Optional[str] = ""
    peer_host:   Optional[str] = ""
    endpoint_count:        Optional[int] = 0
    endpoint_details_json: Optional[str] = "[]"
    vlan:        Optional[int] = 0
```

All endpoint fields are present. The `_coerce_nulls` validator ensures `None` values become defaults.

### DeviceOut Schema (line 337)

```python
class DeviceOut(DeviceBase):
    ports: List[PortOut] = []
```

Ports are included inline. The `Device` ORM model uses `lazy="selectin"` for the ports relationship, so ports are eagerly loaded.

### TopologyOut Schema (line 397)

```python
class TopologyOut(BaseModel):
    nodes: List[DeviceOut]
```

Topology includes devices which include ports.

---

## 5. Topology API Endpoint (`backend/routers/topology.py`)

### GET /api/topology

1. Queries all non-ignored `Device` rows that have a matching `Credential`.
2. SQLAlchemy eagerly loads ports via `selectin` on the `Device.ports` relationship.
3. Wraps each device in `DeviceOut.model_validate(d)`, which auto-includes ports via `PortOut`.
4. Serializes to JSON via `TopologyOut.model_dump_json()`.

**No additional endpoint/MAC data joins are performed.** The topology endpoint relies entirely on what's stored in the `ports` table.

---

## 6. Frontend Tooltip (`frontend/src/components/Port.jsx`)

The tooltip correctly reads and displays:
- `port.peer_ip`, `port.peer_mac`, `port.peer_host`
- `port.endpoint_count`
- `port.endpoint_details_json` (parsed as JSON array)

The `endpointCount` is computed as the max of `endpoint_count`, `parsedEndpoints.length`, and whether `peer_ip`/`peer_mac` exist. The tooltip shows a grid with Hosts, IP, Host, MAC, Port, Speed, VLAN, and a scrollable list for multi-endpoint ports.

---

## 7. Root Cause Analysis: Why Fields Are Empty

The data pipeline is structurally complete. The empty fields must be caused by one or more of:

### 7a. SNMP ARP Walk Returns Empty

**Most likely for Layer 2 switches.** The legacy ARP table (`OID_ARP_MAC` / `OID_ARP_IP` = `.1.3.6.1.2.1.4.22.1.x`) is only populated on devices that perform **Layer 3 routing** (i.e., devices with IP interfaces that process ARP). Pure Layer 2 switches typically have **no ARP table** since they don't resolve IP addresses -- they only maintain MAC forwarding tables.

**Impact**: `sw.arp_table` stays empty. Even if the FDB walk populates `sw.mac_ifindex`, without ARP data there are no IPs to associate, so no entries appear in `peers_by_ifindex`.

### 7b. FDB Walk Returns Empty

Possible reasons:
- Switch does not implement BRIDGE-MIB (e.g., some Layer 3 switches that use a different MIB)
- Wrong FDB strategy for the vendor (dot1d vs qbridge)
- SNMP community/credentials don't have access to the bridge MIB context (some switches require a separate community context per VLAN)
- Bridge-port-to-ifIndex mapping walk (`OID_DOT1D_BASE_PORT_IF_INDEX`) returns empty, so even populated FDB entries can't be mapped to interfaces

### 7c. MAC Format Mismatch Between ARP and FDB

The ARP walk uses `_hex_to_mac()` to parse MAC values. The FDB walk uses `_oid_to_mac()` or `_oid_to_mac_qbridge()` to extract MACs from OID indices. If these produce different MAC string formats (e.g., different case, padding), the join in `scan_engine.py` (`sw.mac_ifindex.get(mac)`) will fail to match.

Both functions normalize to lowercase colon-separated format (`xx:xx:xx:xx:xx:xx`), so this should work correctly in theory.

### 7d. Scan Mode Is Not "full" or "macs"

The `wants_macs` flag in `snmp_scanner.py` is only `True` when `scan_mode in {"full", "ports", "macs"}`. If the scan is triggered as "discovery" or "links" mode, the ARP/FDB walks are entirely skipped.

Similarly, in `scan_engine.py`, `update_ports = scan_mode in {"full", "ports", "macs"}`. The default scan mode is "full", so this should not be the issue for normal scans.

### 7e. Range Probes Only Run Discovery

Range probe scans (from discovery ranges) always use `scan_type="discovery"` (line 552), which skips MAC/ARP collection entirely. Devices found via range probes will only get full port data on the **next** full scan.

---

## 8. Missing Functionality

### 8a. No IP-MIB unified neighbor table usage

The OIDs for `ipNetToPhysicalPhysAddress` (`.1.3.6.1.2.1.4.35.1.4`) are defined but **never used** in the scan logic. The scanner only uses the legacy ARP table OIDs (`.1.3.6.1.2.1.4.22.1.x`). For OPNsense/FreeBSD devices and modern switches, the unified IP-MIB table may be the only available ARP-equivalent.

### 8b. No per-VLAN community context (community indexing)

Many managed switches require SNMP community strings with a VLAN index suffix (e.g., `public@100`) to access per-VLAN FDB tables. Without this, the FDB walk may return empty or only show MACs from the default/management VLAN.

### 8c. No logging of ARP/FDB walk result counts

The final log line in `scan_switch` only reports interface and LLDP neighbor counts, not ARP table or MAC-ifIndex mappings. This makes it difficult to diagnose empty endpoint data without adding debug logging.

### 8d. Q-BRIDGE FDB status filtering not used

`OID_QBRIDGE_FDB_STATUS` is defined but never walked/checked. Filtering for status=3 (learned) could exclude self/static entries that are noise.

---

## 9. Diagnostic Recommendations

1. **Add logging** in `snmp_scanner.py` after the ARP/FDB walks to report:
   - Count of ARP entries (`len(sw.arp_table)`)
   - Count of MAC-ifIndex entries (`len(sw.mac_ifindex)`)
   - Count of bridge-to-ifIndex entries (`len(bridge_to_ifindex)`)

2. **Check SNMP directly** against a target switch:
   ```bash
   snmpwalk -v2c -c <community> <switch_ip> 1.3.6.1.2.1.4.22.1.2   # ARP MACs
   snmpwalk -v2c -c <community> <switch_ip> 1.3.6.1.2.1.17.4.3.1.2  # FDB
   snmpwalk -v2c -c <community> <switch_ip> 1.3.6.1.2.1.17.1.4.1.2  # bridge port -> ifIndex
   ```

3. **Consider querying routers for ARP** separately from switches for FDB, since L2 switches won't have ARP tables.

4. **Implement the unified IP-MIB table** as a fallback for ARP, especially for OPNsense.

---

## 10. Data Flow Diagram

```
SNMP Switch
  |
  |-- ARP Walk (OID_ARP_MAC + OID_ARP_IP)
  |     -> sw.arp_table = {mac: ip}
  |
  |-- FDB Walk (OID_DOT1D_TP_FDB_PORT or OID_QBRIDGE_FDB_PORT)
  |     -> mac -> bridge_port
  |
  |-- Bridge Port Walk (OID_DOT1D_BASE_PORT_IF_INDEX)
  |     -> bridge_port -> ifIndex
  |     => Joined: sw.mac_ifindex = {mac: ifIndex}
  |
  v
scan_engine.py: _execute_scan()
  |
  |-- For each MAC in sw.arp_table:
  |     ifindex = sw.mac_ifindex.get(mac)  <-- JOIN: needs MAC in BOTH tables
  |     if ifindex and ip:
  |       peers_by_ifindex[ifindex].append((mac, ip, host))
  |
  |-- For each interface:
  |     peer_mac, peer_ip, peer_host = first entry from peers_by_ifindex
  |     endpoint_details_json = all entries as JSON
  |     -> INSERT into ports table
  |
  v
Port DB Row
  |  peer_mac, peer_ip, peer_host, endpoint_count, endpoint_details_json
  |
  v
GET /api/topology
  |  Device.ports (selectin eager load) -> PortOut serialization
  |
  v
Frontend Port.jsx
  |  Tooltip displays: peer_ip, peer_mac, peer_host, endpoint_count,
  |  endpoint_details_json (parsed)
```

---

## Analysis File

Path: `docs/SubAgent/ENDPOINT_DATA_ANALYSIS.md`
