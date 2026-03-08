# Endpoint Data Implementation Plan

## Goal

Make port tooltips in the frontend show endpoint data (MAC addresses, IP addresses, hostnames, endpoint counts) by fixing the backend SNMP data collection and port persistence logic.

## Reference Files

- `backend/snmp_scanner.py` - SNMP scan logic (ARP/FDB walks, SwitchData dataclass)
- `backend/scan_engine.py` - Port persistence (peers_by_ifindex construction, ~lines 820-893)
- `docs/SubAgent/ENDPOINT_DATA_ANALYSIS.md` - Root cause analysis

## Root Cause Summary

1. **L2 switches have no ARP table.** The `peers_by_ifindex` loop only iterates over `sw.arp_table`, so MACs found in FDB but absent from ARP are silently dropped. Pure L2 switches always have empty ARP, yielding zero endpoints.
2. **FDB data alone is never used.** Even when `sw.mac_ifindex` is populated (MAC->ifIndex from FDB), if `sw.arp_table` is empty, nothing reaches the port row.
3. **IP-MIB unified neighbor table (`ipNetToPhysicalPhysAddress`) OIDs are defined but never walked.**
4. **No logging** of ARP/FDB walk result counts, making diagnosis impossible.
5. **No cross-device ARP sharing.** A router's ARP table could resolve MACs seen on an L2 switch's FDB, but each device's data is processed in isolation.

---

## Phase 1: MAC-Only Endpoints + Diagnostic Logging

**Objective:** Show MAC addresses on port tooltips even when no IP is available. Add logging to diagnose empty walks.

### Step 1.1: Add diagnostic logging in `snmp_scanner.py`

**File:** `backend/snmp_scanner.py`  
**Location:** After the ARP + FDB parallel walks (~line 640, after the `asyncio.gather` block in step 5)

Add `log.info` lines reporting walk result counts for each device:

```python
log.info(
    "MAC/ARP walk results for %s (%s): arp_mac=%d, arp_ip=%d, base_port=%d, fdb=%d",
    ip, sw.sys_name,
    len(arp_mac_rows), len(arp_ip_rows),
    len(base_port_rows), len(fdb_rows),
)
```

And after ARP table and mac_ifindex construction, log the final counts:

```python
log.info(
    "Endpoint tables for %s (%s): arp_table=%d entries, mac_ifindex=%d entries",
    ip, sw.sys_name,
    len(sw.arp_table), len(sw.mac_ifindex),
)
```

- [ ] Add log.info after ARP/FDB asyncio.gather with raw row counts
- [ ] Add log.info after ARP table and mac_ifindex construction with final entry counts

### Step 1.2: Populate MAC-only endpoints in `scan_engine.py`

**File:** `backend/scan_engine.py`  
**Location:** The `peers_by_ifindex` construction block (~lines 844-850)

Currently, the code only iterates over `sw.arp_table` to build `peers_by_ifindex`. MACs present in `sw.mac_ifindex` but absent from `sw.arp_table` are dropped.

**Change:** After the existing ARP-based loop, add a second loop over `sw.mac_ifindex` to include MAC-only entries (where no IP is known):

```python
# Existing loop (ARP-based: MAC -> IP, look up ifindex)
for mac, peer_ip in sw.arp_table.items():
    ifindex = sw.mac_ifindex.get(mac)
    if ifindex is None or not peer_ip:
        continue
    peer_host = _resolve_host(peer_ip, dns_cache, dns_servers, correlation_id=corr)
    peers_by_ifindex.setdefault(ifindex, []).append((mac, peer_ip, peer_host))

# NEW: MAC-only entries (FDB has MAC->ifIndex, but no ARP entry for this MAC)
macs_with_arp = set(sw.arp_table.keys())
for mac, ifindex in sw.mac_ifindex.items():
    if mac in macs_with_arp:
        continue  # already handled above
    peers_by_ifindex.setdefault(ifindex, []).append((mac, "", ""))
```

**Sorting adjustment:** The existing sort `key=lambda x: x[1]` sorts by IP. With MAC-only entries (empty IP), update the sort key to handle empty IPs gracefully (they sort first, which is fine -- or sort by MAC as secondary):

```python
endpoint_entries = sorted(
    peers_by_ifindex[iface.index],
    key=lambda x: (x[1] == "", x[1], x[0])  # IPs first, then MAC-only; secondary sort by MAC
)
```

**Primary entry selection:** When choosing the "primary" endpoint for `peer_mac`/`peer_ip`/`peer_host`, prefer an entry that has an IP over one that is MAC-only:

```python
if iface.index in peers_by_ifindex and peers_by_ifindex[iface.index]:
    endpoint_entries = sorted(
        peers_by_ifindex[iface.index],
        key=lambda x: (x[1] == "", x[1], x[0])
    )
    peer_mac, peer_ip, peer_host = endpoint_entries[0]
```

This sort puts entries with IPs first (since `"" == ""` is True for MAC-only, False for those with IPs, and False < True).

Wait -- `x[1] == ""` returns True for MAC-only (empty IP), which sorts AFTER entries with IPs (`False` < `True`). So entries WITH IPs come first. Correct.

- [ ] Add MAC-only loop after existing ARP-based loop in `peers_by_ifindex` construction
- [ ] Update endpoint sorting to handle empty IPs (entries with IP sort first)
- [ ] Verify primary entry selection prefers entries with IPs

### Step 1.3: Filter out device's own MACs and uplink MACs

**File:** `backend/scan_engine.py`  
**Location:** In the MAC-only loop added in Step 1.2

Without filtering, the MAC-only loop could add hundreds of MACs to a trunk/uplink port (including MACs learned from the entire network). To keep the data useful:

1. **Skip MACs that belong to LLDP neighbors** (these are uplink/interswitch links, handled by LLDP topology).
2. **Skip the device's own MAC** if it appears in the FDB.

Build a set of LLDP neighbor MACs before the loop:

```python
# Collect MACs of LLDP neighbors for this device (to skip uplink ports)
lldp_ifindexes = set()
for nbr in sw.lldp_neighbors:
    lldp_ifindexes.add(nbr.local_port_idx)
```

Then in the MAC-only loop, skip MACs on ports that have LLDP neighbors:

```python
for mac, ifindex in sw.mac_ifindex.items():
    if mac in macs_with_arp:
        continue
    if ifindex in lldp_ifindexes:
        continue  # skip uplink/interswitch ports
    peers_by_ifindex.setdefault(ifindex, []).append((mac, "", ""))
```

- [ ] Build `lldp_ifindexes` set from `sw.lldp_neighbors`
- [ ] Skip MAC-only entries on ports with LLDP neighbors (interswitch links)

---

## Phase 2: Shared ARP Table from Routers

**Objective:** Collect ARP tables from all scanned devices and merge them into a global MAC->IP lookup. Apply this global ARP to resolve IPs for FDB-only MACs on L2 switches.

### Step 2.1: Build a global ARP table in `scan_engine.py`

**File:** `backend/scan_engine.py`  
**Location:** Before the per-device port update loop (~line 830, after `dns_cache` initialization)

After all devices have been scanned (all `switch_data` is available), build a merged ARP table from all devices:

```python
# Build global ARP table: merge ARP from all scanned devices
# (Routers/L3 switches have the most complete ARP tables)
global_arp: Dict[str, str] = {}
for sw in switch_data.values():
    for mac, arp_ip in sw.arp_table.items():
        if mac and arp_ip:
            global_arp.setdefault(mac, arp_ip)  # first-seen wins (don't overwrite)

log.info(
    "Global ARP table: %d entries merged from %d devices",
    len(global_arp), len(switch_data),
)
```

- [ ] Build `global_arp` dict by merging all devices' `arp_table` before the per-device loop

### Step 2.2: Use global ARP in the MAC-only loop

**File:** `backend/scan_engine.py`  
**Location:** The MAC-only loop added in Step 1.2

When adding a MAC-only entry, check the global ARP table first to see if any other device (e.g., a router) knows the IP for this MAC:

```python
for mac, ifindex in sw.mac_ifindex.items():
    if mac in macs_with_arp:
        continue  # already handled by device's own ARP
    if ifindex in lldp_ifindexes:
        continue  # skip uplink/interswitch ports
    # Try to resolve IP from global ARP (e.g., router's ARP table)
    resolved_ip = global_arp.get(mac, "")
    resolved_host = ""
    if resolved_ip:
        resolved_host = _resolve_host(resolved_ip, dns_cache, dns_servers, correlation_id=corr)
    peers_by_ifindex.setdefault(ifindex, []).append((mac, resolved_ip, resolved_host))
```

- [ ] Look up each MAC-only entry in `global_arp` to resolve IP
- [ ] Resolve hostname via DNS if IP is found
- [ ] Append the (mac, ip_or_empty, host_or_empty) tuple

### Step 2.3: Also use global ARP in the existing ARP-based loop

**File:** `backend/scan_engine.py`  
**Location:** The existing ARP-based `peers_by_ifindex` loop

The existing loop only uses `sw.arp_table` (the device's own ARP). Enhance it to also check `global_arp` for any MACs that have an ifindex but aren't in the device's own ARP. This is already handled by the MAC-only loop in Step 2.2, so no additional change is needed here -- the MAC-only loop covers this case.

- [ ] Confirm no additional change needed in existing ARP loop (MAC-only loop handles the gap)

---

## Phase 3: IP-MIB Unified Neighbor Table Fallback

**Objective:** Walk `ipNetToPhysicalPhysAddress` (IP-MIB unified table) when the legacy ARP table returns empty. This is especially useful for OPNsense/FreeBSD and newer network OS versions that use the unified table.

### Step 3.1: Add IP-MIB unified table walk in `snmp_scanner.py`

**File:** `backend/snmp_scanner.py`  
**Location:** After the existing ARP table construction, inside the `if wants_macs:` block (~after line 655)

If the legacy ARP walk returned zero entries, fall back to the IP-MIB unified neighbor table:

```python
# Fallback: try IP-MIB unified neighbor table if legacy ARP was empty
if not sw.arp_table:
    log.info("Legacy ARP empty for %s, trying IP-MIB unified neighbor table", ip)
    unified_rows = await snmp_bulk_walk(
        ip, snmp_port, auth, OID_IP_NET_TO_PHYSICAL_MAC,
        timeout=snmp_timeout, retries=snmp_retries, engine=engine,
    )
    log.info("IP-MIB unified walk for %s: %d rows", ip, len(unified_rows))
    for oid_s, mac_val in unified_rows:
        # OID index: {ifIndex}.{addrType}.{addrLen}.{addr...}
        # addrType: 1=IPv4, 2=IPv6
        # For IPv4: addrLen=4, followed by 4 octets
        mac = _hex_to_mac(mac_val)
        if not mac:
            continue
        parts = oid_s.split(".")
        try:
            # Find the base OID length to know where the index starts
            base_len = len(OID_IP_NET_TO_PHYSICAL_MAC.split("."))
            idx_parts = parts[base_len:]
            # idx_parts = [ifIndex, addrType, addrLen, addr...]
            addr_type = int(idx_parts[1])
            addr_len = int(idx_parts[2])
            if addr_type == 1 and addr_len == 4:
                # IPv4: next 4 parts are the IP octets
                peer_ip = ".".join(idx_parts[3:3+4])
                sw.arp_table[mac] = peer_ip
            # Skip IPv6 for now (addrType == 2)
        except (IndexError, ValueError):
            continue
```

- [ ] After legacy ARP table construction, check if `sw.arp_table` is empty
- [ ] If empty, walk `OID_IP_NET_TO_PHYSICAL_MAC` as fallback
- [ ] Parse the OID index to extract IPv4 addresses (addrType==1, addrLen==4)
- [ ] Populate `sw.arp_table` with the resolved MAC->IP entries
- [ ] Log the fallback walk result count

### Step 3.2: Log final endpoint table state

**File:** `backend/snmp_scanner.py`  
**Location:** After the fallback logic (end of step 5 / wants_macs block)

Ensure the final log line (added in Step 1.1) runs after the fallback, so it reflects the true state:

```python
log.info(
    "Endpoint tables for %s (%s): arp_table=%d entries, mac_ifindex=%d entries (strategy=%s)",
    ip, sw.sys_name,
    len(sw.arp_table), len(sw.mac_ifindex), fdb_strategy,
)
```

- [ ] Ensure final endpoint table log runs after IP-MIB fallback

---

## Implementation Checklist

### Phase 1: MAC-Only + Logging
- [ ] 1.1a: Add `log.info` after ARP/FDB walks with raw row counts (`snmp_scanner.py`)
- [ ] 1.1b: Add `log.info` after ARP/FDB table construction with entry counts (`snmp_scanner.py`)
- [ ] 1.2a: Add MAC-only loop over `sw.mac_ifindex` in `scan_engine.py`
- [ ] 1.2b: Update sort key to handle empty IPs
- [ ] 1.3a: Build `lldp_ifindexes` set from LLDP neighbors
- [ ] 1.3b: Skip MAC-only entries on LLDP ports

### Phase 2: Shared ARP
- [ ] 2.1: Build `global_arp` dict merging all devices' ARP tables (`scan_engine.py`)
- [ ] 2.2: Use `global_arp` to resolve IPs for MAC-only entries

### Phase 3: IP-MIB Fallback
- [ ] 3.1: Walk `ipNetToPhysicalPhysAddress` when legacy ARP is empty (`snmp_scanner.py`)
- [ ] 3.2: Ensure final logging reflects IP-MIB fallback results

---

## Files Modified

| File | Changes |
|------|---------|
| `backend/snmp_scanner.py` | Add diagnostic logging (1.1), IP-MIB unified fallback walk (3.1) |
| `backend/scan_engine.py` | MAC-only peers loop (1.2), LLDP port filtering (1.3), global ARP merge (2.1), global ARP lookup (2.2) |

## Testing Strategy

1. **Logging verification:** Run a full scan, check logs for the new `MAC/ARP walk results` and `Endpoint tables` lines. Verify counts are non-zero for devices with FDB data.
2. **MAC-only:** After Phase 1, scan an L2 switch. Port tooltips should show MAC addresses and endpoint counts even without IPs.
3. **Shared ARP:** After Phase 2, scan a network with a router + L2 switches. The router's ARP should resolve IPs for MACs on L2 switch ports.
4. **IP-MIB fallback:** After Phase 3, scan an OPNsense device. If legacy ARP is empty, the unified table should populate ARP entries.

## Risk Assessment

- **Low risk:** All changes are additive. Existing ARP+FDB join logic is untouched.
- **MAC-only noise:** The LLDP port filter (Step 1.3) prevents flooding uplink ports with hundreds of transit MACs. Only access ports (no LLDP neighbor) get MAC-only entries.
- **Global ARP conflicts:** `setdefault` ensures first-seen IP wins. If multiple routers report different IPs for the same MAC, first scanned wins. This is acceptable.
- **Performance:** The IP-MIB walk is only triggered when legacy ARP is empty (most devices), so no additional SNMP overhead on devices where legacy ARP works.
