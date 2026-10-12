# DEVELOPMENT SEED DATA ONLY -- do not run against production databases.
"""
Seed script – populates the Net2Map database with realistic dummy data.

Topology
────────
  5 Racks (Rack-A … Rack-E) across 3 server rooms
  Each rack:
    • 2× FS.com S5860-20SQ   (Top-of-Rack, vendor = "fs")
    • 3× Aruba CX switches   (Access, vendor = "aruba_cx")
        – 2× Aruba CX 6300M connected to FS TOR-1
        – 1× Aruba CX 6200F  connected to FS TOR-2
    • 1× UniFi AP            (outside rack, vendor = "unifi")
        – class "Access Point" has allow_outside_rack=True, so the AP is
          rendered on the map without a rack assignment

Links (stored as TopologyLink / LLDP)
    • Within rack  : FS TOR-1 ↔ FS TOR-2  (100G inter-switch trunk)
    • Within rack  : Aruba-1/2 → FS TOR-1  (10G uplink)
    • Within rack  : Aruba-3   → FS TOR-2  (10G uplink)
    • Within rack  : AP eth0   → one Aruba access port (2.5G, rotating)
    • Inter-rack   : ring A→B→C→D→E→A via FS TOR-2 100G uplink ports

Spanning tree (RSTP) / VLANs
    • fs-rack-a-tor1 is the root bridge; the 10-switch TOR ring is a loop, so
      fs-rack-c-tor2 HundredGigE1/2 (toward fs-rack-d-tor1) is blocking
    • Trunk ports carry tagged VLANs; every switch reports VLAN names

Credentials
    • One SNMPv3 credential per FS TOR switch   (authPriv / SHA-256 / AES-128)
    • One SNMPv3 credential per Aruba CX switch (authPriv / SHA-256 / AES-256)
    • One SNMPv2c credential per AP             (community "public")

Demo enrichment (so every UI page is populated)
    • Switch models (faceplate layout) linked to the devices, firmware, ping
      state, interface name cache; racks placed at their map cluster centers
    • aruba-rack-e-acc2 and ap-rack-b-01 are offline (ongoing outage)
    • Each UniFi AP gets two wireless ports (wifi0 corp SSID, wifi1 guest SSID)
    • ~200 endpoints with realistic OUIs on access and wireless ports, plus
      older associations (moved endpoints) and inactive endpoints
    • 21 scan runs over the last ~3 days (one partial run with timeouts, one
      dry run with a stored preview) including per-switch metrics
    • latency_samples: last 24 h per minute, days 2-7 every 15 minutes;
      ap-rack-c-01 is degraded and aruba-rack-d-acc3 has packet loss in the
      last hour
    • Audit trail, demo users, app settings (discovery ranges, DNS servers,
      scheduled scan intervals set to 0 = disabled because all IPs are fake)
    • Redis: structured log buffer (net2map:logs), live latency state,
      heartbeat and baselines (one simulated monitor round)

Demo users (password "demo-password"):
    operator (role operator), viewer (role viewer), noc-admin (role admin).
    The "admin" user created by migration 006 is never modified or deleted.

Usage
    python seed_db.py                     wipe the demo tables and reseed them
    python seed_db.py --simulate-latency  run a latency monitor simulator until
                                          SIGTERM/SIGINT: every
                                          latency_interval_sec it publishes
                                          simulated state to Redis and upserts
                                          the current-minute latency_samples
                                          rows (no ICMP)
"""
import argparse
import asyncio
import contextlib
import json
import logging
import math
import os
import random
import signal
import sys
import uuid
import zlib
from collections import deque
from datetime import datetime, timedelta, timezone

# ── Make sure we can import the app's own modules ────────────────────────────
sys.path.insert(0, os.path.dirname(__file__))

from sqlalchemy import insert
from sqlalchemy.orm import Session

from database import (
    AppSetting,
    AuditLog,
    Credential,
    Device,
    DryRunResult,
    Endpoint,
    EndpointPortAssociation,
    LatencySample,
    Port,
    ScanRun,
    ScanRunSwitchMetric,
    SnmpProfile,
    SwitchClass,
    SwitchModel,
    TopologyLink,
    User,
    create_tables,
    engine,
)
from database import (
    Rack as RackModel,
)
from latency import stats, store
from latency.monitor import WINDOW_SIZE, LatencyMonitor
from latency.probe import Sample

# ─── Deterministic random so IPs/MACs are the same on every run ──────────────
rng = random.Random(42)


def rand_mac() -> str:
    return ":".join(f"{rng.randint(0,255):02x}" for _ in range(6))


def rand_ip(rack_idx: int, sw_idx: int, port_idx: int) -> str:
    return f"10.{rack_idx+1}.{sw_idx+1}.{port_idx+1}"


# ─── Rack definitions ─────────────────────────────────────────────────────────

RACKS = [
    {"id": "rack-a", "label": "Rack A", "room": "RZ-01"},
    {"id": "rack-b", "label": "Rack B", "room": "RZ-01"},
    {"id": "rack-c", "label": "Rack C", "room": "RZ-02"},
    {"id": "rack-d", "label": "Rack D", "room": "RZ-02"},
    {"id": "rack-e", "label": "Rack E", "room": "RZ-03"},
]

# (x, y) of each rack node on the topology map: a pentagon spaced so rack
# nodes and their access points do not overlap at the default zoom.
RACK_CENTERS = [
    (100, 260),   # Rack A
    (560, 40),    # Rack B
    (1020, 260),  # Rack C
    (840, 660),   # Rack D
    (280, 660),   # Rack E
]

# Offsets within a cluster (fs1, fs2, aruba1, aruba2, aruba3)
CLUSTER_OFFSETS = [
    (-40, -50),   # FS TOR-1
    ( 40, -50),   # FS TOR-2
    (-70,  45),   # Aruba CX-1  → TOR-1
    (  0,  45),   # Aruba CX-2  → TOR-1
    ( 70,  45),   # Aruba CX-3  → TOR-2
]

# Access points (no rack assignment) sit outside the ring, next to their rack.
AP_OFFSETS = [
    (-40, 190),   # Rack A: below
    (340, 10),    # Rack B: right
    (40, 190),    # Rack C: below
    (-40, 190),   # Rack D: below
    (-340, 120),  # Rack E: left
]

AP_MODELS = [
    {"model": "UniFi U6 Pro",        "descr": "UniFi U6 Pro, UniFi OS 6.6.77"},
    {"model": "UniFi U7 Pro",        "descr": "UniFi U7 Pro, UniFi OS 7.0.15"},
    {"model": "UniFi U6 Enterprise", "descr": "UniFi U6 Enterprise, UniFi OS 6.6.77"},
]

# Rack elevation placement (1-based U, same order as CLUSTER_OFFSETS):
# TOR switches at the top, access switches below a patch-panel gap.
RACK_U_POSITIONS = [42, 41, 38, 37, 36]

# ─── Switch templates ─────────────────────────────────────────────────────────

FS_MODEL    = "FS S5860-20SQ"
FS_DESCR    = "FS S5860-20SQ 20-Port 25GbE SFP28 Switch, FSOS 9.2.1"
FS_OID      = "1.3.6.1.4.1.52642.1.1"   # FS enterprise OID prefix

ARUBA_CX_6300 = {
    "model":  "Aruba CX 6300M",
    "descr":  "ArubaOS-CX 6300M 24-port 1GbE, 4-port SFP+, JL658A",
    "oid":    "1.3.6.1.4.1.47196.4.1",
}
ARUBA_CX_6200 = {
    "model":  "Aruba CX 6200F",
    "descr":  "ArubaOS-CX 6200F 48G 4SFP+ Switch JL728A",
    "oid":    "1.3.6.1.4.1.47196.4.1",
}

# Ports per switch type ----------------------------------------------------------
# FS S5860-20SQ: 20× 25G SFP28 (index 1-20) + 2× 100G QSFP28 (index 21-22)
def make_fs_ports(device_id: int, rack_idx: int, sw_idx: int) -> list[Port]:
    ports = []
    for i in range(1, 21):          # 25G downlinks / access
        ports.append(Port(
            device_id   = device_id,
            if_index    = i,
            if_descr    = f"Eth1/{i}",
            if_alias    = f"access-port-{i}",
            speed_mbps  = 25_000,
            oper_status = 1 if rng.random() > 0.3 else 2,
            vlan        = rng.choice([10, 20, 30, 40, 100]),
        ))
    for i in range(21, 23):         # 100G QSFP28 uplinks
        ports.append(Port(
            device_id   = device_id,
            if_index    = i,
            if_descr    = f"HundredGigE1/{i-20}",
            if_alias    = f"uplink-{i-20}",
            speed_mbps  = 100_000,
            oper_status = 1,
            vlan        = 1,
        ))
    return ports


# Aruba CX 6300M: 24× 1G (1-24) + 4× 10G SFP+ (25-28)
def make_aruba_6300_ports(device_id: int, rack_idx: int, sw_idx: int) -> list[Port]:
    ports = []
    for i in range(1, 25):
        ports.append(Port(
            device_id   = device_id,
            if_index    = i,
            if_descr    = f"1/1/{i}",
            if_alias    = f"access-{i}",
            speed_mbps  = 1_000,
            oper_status = 1 if rng.random() > 0.35 else 2,
            vlan        = rng.choice([10, 20, 30, 40, 100]),
        ))
    for i in range(25, 29):
        ports.append(Port(
            device_id   = device_id,
            if_index    = i,
            if_descr    = f"1/1/{i}",
            if_alias    = "uplink" if i < 27 else "unused",
            speed_mbps  = 10_000,
            oper_status = 1 if i < 27 else 2,
            vlan        = 1,
        ))
    return ports


# Aruba CX 6200F: 48× 1G (1-48) + 4× 10G SFP+ (49-52)
def make_aruba_6200_ports(device_id: int, rack_idx: int, sw_idx: int) -> list[Port]:
    ports = []
    for i in range(1, 49):
        ports.append(Port(
            device_id   = device_id,
            if_index    = i,
            if_descr    = f"1/1/{i}",
            if_alias    = f"access-{i}",
            speed_mbps  = 1_000,
            oper_status = 1 if rng.random() > 0.35 else 2,
            vlan        = rng.choice([10, 20, 30, 40, 100]),
        ))
    for i in range(49, 53):
        ports.append(Port(
            device_id   = device_id,
            if_index    = i,
            if_descr    = f"1/1/{i}",
            if_alias    = "uplink" if i == 49 else "unused",
            speed_mbps  = 10_000,
            oper_status = 1 if i == 49 else 2,
            vlan        = 1,
        ))
    return ports


# ─── VLAN / spanning tree overlay ─────────────────────────────────────────────

SWITCH_VLAN_NAMES = {
    "1": "default", "10": "Management", "20": "Clients", "30": "VoIP",
    "40": "Servers", "99": "Guest", "100": "Storage",
}
AP_VLAN_NAMES = {"1": "default", "20": "Clients", "99": "Guest"}

TOR_TRUNK_VLANS    = [10, 20, 30, 40, 99, 100]
ACCESS_TRUNK_VLANS = [10, 20, 30, 40, 99]
AP_TRUNK_VLANS     = [20, 99]

# IEEE 802.1t (RSTP) port path costs by link speed in Mbps
STP_PATH_COST = {100_000: 200, 25_000: 800, 10_000: 2_000, 2_500: 8_000, 1_000: 20_000, 100: 200_000}

STP_RING_HOP_COST = STP_PATH_COST[100_000]
STP_UPLINK_COST   = STP_PATH_COST[10_000]


def _bridge_id(priority: int, ri: int, slot: int) -> str:
    """Deterministic demo bridge ID: '<prio hex4>.<locally administered MAC>'."""
    return f"{priority:04x}.02a0c9{ri + 1:02x}{slot + 1:02x}00"


def apply_vlan_stp_overlay(db: Session, devices_by_rack: dict) -> None:
    """Seed VLAN names, trunk tagged VLANs and a consistent RSTP tree.

    The TOR switches form a 10-node ring (tor1 -> tor2 within a rack via
    HundredGigE1/1, tor2 -> next rack tor1 via HundredGigE1/2). fs-rack-a-tor1
    is the root; every other TOR picks the shorter ring direction toward it.
    The node opposite the root (ring position 5, fs-rack-c-tor2) has equal
    cost both ways: it keeps the port toward the previous ring node as root
    port and blocks the other one. Access switches use their uplink as root
    port; the UniFi APs report no spanning tree.
    """
    ring: list[tuple[Device, int, int]] = []   # (device, rack index, slot)
    for ri, rack in enumerate(RACKS):
        d = devices_by_rack[rack["id"]]
        ring.append((d["fs1"], ri, 0))
        ring.append((d["fs2"], ri, 1))
    ring_len = len(ring)
    root_dev, root_ri, root_slot = ring[0]
    root_id = _bridge_id(0x1000, root_ri, root_slot)

    def ports_of(dev: Device) -> dict[str, Port]:
        return {p.if_descr: p for p in db.query(Port).filter(Port.device_id == dev.id).all()}

    def set_default_port_stp(ports: dict[str, Port]) -> None:
        for p in ports.values():
            p.stp_path_cost = STP_PATH_COST.get(p.speed_mbps, 20_000)
            if p.oper_status == 1:
                p.stp_state, p.stp_role = "forwarding", "designated"
            else:
                p.stp_state, p.stp_role = "disabled", "disabled"

    def set_stp(dev: Device, priority: int, ri: int, slot: int,
                root_cost: int, root_port: str | None) -> None:
        dev.stp_protocol  = "rstp"
        dev.stp_bridge_id = _bridge_id(priority, ri, slot)
        dev.stp_root_id   = root_id
        dev.stp_root_cost = root_cost
        dev.stp_root_port = root_port
        dev.vlan_names    = dict(SWITCH_VLAN_NAMES)

    tor_cost: dict[int, int] = {}
    for k, (dev, ri, slot) in enumerate(ring):
        is_tor1 = slot == 0
        prev_port = "HundredGigE1/2" if is_tor1 else "HundredGigE1/1"
        next_port = "HundredGigE1/1" if is_tor1 else "HundredGigE1/2"
        ports = ports_of(dev)
        set_default_port_stp(ports)
        for name in ("HundredGigE1/1", "HundredGigE1/2"):
            ports[name].tagged_vlans = list(TOR_TRUNK_VLANS)
        for name in ("Eth1/1", "Eth1/2") if is_tor1 else ("Eth1/1",):
            ports[name].tagged_vlans = list(ACCESS_TRUNK_VLANS)
            ports[name].oper_status = 1
            ports[name].stp_state, ports[name].stp_role = "forwarding", "designated"

        if k == 0:
            set_stp(dev, 0x1000, ri, slot, 0, None)
            tor_cost[dev.id] = 0
            continue
        hops = min(k, ring_len - k)
        root_port = prev_port if k <= ring_len - k else next_port
        set_stp(dev, 0x2000, ri, slot, hops * STP_RING_HOP_COST, root_port)
        tor_cost[dev.id] = hops * STP_RING_HOP_COST
        ports[root_port].stp_role = "root"
        if k == ring_len - k:
            # Equal cost both ways: the second ring port is the alternate.
            ports[next_port].stp_state, ports[next_port].stp_role = "blocking", "blocked"

    for ri, rack in enumerate(RACKS):
        d = devices_by_rack[rack["id"]]
        ap_uplink_sw = [d["aruba1"], d["aruba2"], d["aruba3"]][ri % 3]
        for slot, key, uplink, tor_key in (
            (2, "aruba1", "1/1/25", "fs1"),
            (3, "aruba2", "1/1/25", "fs1"),
            (4, "aruba3", "1/1/49", "fs2"),
        ):
            dev = d[key]
            ports = ports_of(dev)
            set_default_port_stp(ports)
            for p in ports.values():
                if p.if_alias == "uplink":
                    p.tagged_vlans = list(ACCESS_TRUNK_VLANS)
            ports[uplink].stp_role = "root"
            if dev is ap_uplink_sw:
                ports["1/1/3"].tagged_vlans = list(AP_TRUNK_VLANS)
                ports["1/1/3"].oper_status = 1
                ports["1/1/3"].stp_state, ports["1/1/3"].stp_role = "forwarding", "designated"
            set_stp(dev, 0x8000, ri, slot, tor_cost[d[tor_key].id] + STP_UPLINK_COST, uplink)

        ap = d["ap"]
        ap.vlan_names = dict(AP_VLAN_NAMES)
        for p in ports_of(ap).values():
            p.tagged_vlans = list(AP_TRUNK_VLANS)


# ─── Demo enrichment: constants ───────────────────────────────────────────────

DEMO_PASSWORD = "demo-password"
# (username, role, email); roles as enforced by shared.auth.require_role
DEMO_USERS = [
    ("operator", "operator", "operator@demo.example"),
    ("viewer", "viewer", "viewer@demo.example"),
    ("noc-admin", "admin", "noc-admin@demo.example"),
]

DISCOVERY_RANGES = [f"192.168.{i}.0/24" for i in range(1, 6)] + ["192.168.10.0/24"]
DNS_SERVERS = ["10.10.40.10", "10.10.40.11"]
# Stored like the API stores them (JSON lists as strings). Scheduled scans are
# disabled (0) because every seeded IP is fake; the scheduler and the Celery
# scheduler_tick skip intervals <= 0.
DEMO_SETTINGS = {
    "discovery_scan_ranges": json.dumps(DISCOVERY_RANGES),
    "dns_servers": json.dumps(DNS_SERVERS),
    "discovery_interval_sec": "0",
    "link_update_interval_sec": "0",
    "mac_update_interval_sec": "0",
}

# (name, ports_per_row = port pairs per faceplate row, total_ports, description).
# The AP models show only the physical uplink on the faceplate (total_ports=1);
# the wireless ports exist for endpoint associations.
SWITCH_MODEL_DEFS = [
    (FS_MODEL, 11, 22, "FS.com 20x 25G SFP28 + 2x 100G QSFP28 top-of-rack switch"),
    (ARUBA_CX_6300["model"], 14, 28, "HPE Aruba CX 6300M, 24x 1G access + 4x 10G SFP+ uplinks (JL658A)"),
    (ARUBA_CX_6200["model"], 26, 52, "HPE Aruba CX 6200F, 48x 1G access + 4x 10G SFP+ uplinks (JL728A)"),
    ("UniFi U6 Pro", 1, 1, "Ubiquiti UniFi U6 Pro Wi-Fi 6 access point"),
    ("UniFi U7 Pro", 1, 1, "Ubiquiti UniFi U7 Pro Wi-Fi 7 access point"),
    ("UniFi U6 Enterprise", 1, 1, "Ubiquiti UniFi U6 Enterprise Wi-Fi 6E access point"),
]

# Rack E runs older firmware so the device table shows a version spread.
FIRMWARE_DRIFT_RACK = "rack-e"

# Availability windows in minutes before seed time: (start, end); end 0 means
# the outage is ongoing (device offline now).
OUTAGES = {
    "aruba-rack-e-acc2": [(200, 0)],
    "ap-rack-b-01": [(47, 0)],
    "aruba-rack-d-acc1": [(2185, 2145)],   # rack D maintenance, see partial scan run
    "aruba-rack-d-acc2": [(2185, 2145)],
}
DEGRADED = {"ap-rack-c-01": (60, 3.5, 6.0)}   # since (min ago), RTT factor, added ms
LOSSY = {"aruba-rack-d-acc3": (55, 0.2)}       # since (min ago), loss probability per echo
DEVICE_ADDED = {"ap-rack-e-01": 2880}          # minutes ago the device first appeared

# (minutes ago the run finished, kind), newest first. "dry_run" is a manual
# discovery preview; the others are scheduled scans.
SCAN_SCHEDULE = [
    (4, "macs"), (34, "links"), (64, "macs"), (125, "discovery"), (186, "macs"), (250, "links"),
    (370, "macs"), (610, "discovery"), (900, "macs"), (1200, "dry_run"), (1450, "links"),
    (1800, "discovery"), (2160, "macs"), (2520, "links"), (2880, "discovery"), (3240, "macs"),
    (3600, "links"), (3960, "discovery"), (4320, "macs"), (4380, "links"), (4500, "discovery"),
]
SCAN_MAX_WORKERS = 12
SCAN_DURATION_MS = {"discovery": (900, 2600), "links": (350, 1300), "macs": (1400, 4800)}
SCAN_TIMEOUT_ERROR = "No SNMP response (timeout)"
# Hosts found only by the dry-run range probe (192.168.10.0/24, lab bench).
DRY_RUN_NEW_HOSTS = [
    {"ip": "192.168.10.21", "sys_name": "lab-aruba-6100",
     "sys_descr": "Aruba JL679A 6100 12G CL4 2SFP+ Switch, PL.10.13.1010",
     "vendor": "aruba_cx", "location": "Lab / bench 2", "firmware": "PL.10.13.1010"},
    {"ip": "192.168.10.22", "sys_name": "lab-fs-s3900",
     "sys_descr": "FS S3900-24T4S 24-Port Gigabit Switch, FSOS 9.2.1",
     "vendor": "fs", "location": "Lab / bench 2", "firmware": "FSOS 9.2.1"},
]
DRY_RUN_NO_PROFILE_IP = "192.168.10.40"

DEFAULT_PINGS = 3
SAMPLES_PER_MINUTE = 6          # 10 s monitor interval
HISTORY_COARSE_STEP_MIN = 15    # days 2-7
HISTORY_DAYS = 7

# Endpoint OUIs (lowercase, colon separated) per endpoint kind.
ENDPOINT_OUIS = {
    "dell_pc": ["18:66:da", "f8:b1:56", "98:90:96"],
    "lenovo_pc": ["54:ee:75", "e8:6a:64", "8c:16:45"],
    "hp_pc": ["3c:52:82", "9c:8e:99"],
    "apple": ["f0:18:98", "a4:83:e7", "3c:22:fb"],
    "intel_wifi": ["a4:c3:f0", "8c:8d:28"],
    "printer": ["00:80:77", "30:05:5c"],
    "phone": ["80:5e:c0", "00:15:65", "64:16:7f"],
    "server": ["94:40:c9", "98:f2:b3", "24:6e:96", "b0:83:fe", "0c:c4:7a"],
    "esx": ["94:40:c9", "24:6e:96", "ac:1f:6b"],
    "vm": ["00:50:56"],
    "bmc": ["d0:94:66", "ac:1f:6b"],
    "ups": ["00:c0:b7"],
    "pdu": ["00:0d:5d"],
    "camera": ["00:40:8c", "ac:cc:8e"],
    "storage": ["00:a0:98", "24:a9:37", "00:11:32"],
}
DESK_KINDS = [("dell_pc", 4), ("lenovo_pc", 3), ("hp_pc", 2), ("apple", 2)]
VLAN_ENDPOINT_KINDS = {
    10: [("bmc", 4), ("ups", 1), ("pdu", 2), ("camera", 2)],
    20: [*DESK_KINDS, ("printer", 1)],
    30: [("phone", 1)],
    40: [("server", 3), ("esx", 2)],
    99: [("random", 1)],
    100: [("storage", 1)],
}
WIRELESS_CORP_KINDS = [("apple", 3), ("intel_wifi", 3), ("random", 2)]
LOW_SPEED_KINDS = {"printer", "ups", "pdu", "camera"}
DEPARTMENTS = ["fin", "hr", "eng", "ops", "sales", "it", "legal"]
SERVER_ROLES = ["db", "app", "web", "backup", "mon", "git", "ci", "log"]
# Locally administered first octets (randomized "private" Wi-Fi MACs).
RANDOM_MAC_FIRST_OCTETS = ["da", "de", "f6", "6e", "a2", "3a", "be", "56"]


# ─── Demo enrichment: availability and latency model ──────────────────────────

def in_outage(name: str, minutes_ago: float) -> bool:
    return any(end <= minutes_ago <= start for start, end in OUTAGES.get(name, ()))


def ongoing_outage_start(name: str) -> float | None:
    starts = [start for start, end in OUTAGES.get(name, ()) if end == 0]
    return max(starts) if starts else None


def device_exists(name: str, minutes_ago: float) -> bool:
    return minutes_ago <= DEVICE_ADDED.get(name, math.inf)


def latency_profile(sys_name: str, vendor: str) -> tuple[float, float]:
    """Deterministic (baseline RTT ms, jitter scale ms) per device name."""
    prof_rng = random.Random(zlib.crc32((sys_name or "").encode()))
    if vendor == "fs":
        base = prof_rng.uniform(0.22, 0.45)
    elif vendor == "unifi":
        base = prof_rng.uniform(1.8, 3.4)
    else:
        base = prof_rng.uniform(0.6, 1.3)
    return base, base * prof_rng.uniform(0.08, 0.2)


def simulate_sample(device_id: int, name: str, base: float, jitter: float, ts: datetime,
                    minutes_ago: float, pings: int, rnd: random.Random) -> Sample:
    """One simulated probe of ``pings`` echo requests, shaped like latency.probe.probe()."""
    pings = max(1, int(pings))
    lost = Sample(device_id=device_id, ts=ts, rtt_avg_ms=None, rtt_min_ms=None, rtt_max_ms=None,
                  jitter_ms=None, loss_pct=100.0, sent=pings)
    if in_outage(name, minutes_ago):
        return lost
    # Rare background loss only in the history: in the live window (18 echoes)
    # a single lost echo would already flip the status to "loss".
    factor, add_ms, loss_p = 1.0, 0.0, (0.0005 if minutes_ago >= 1 else 0.0)
    degraded = DEGRADED.get(name)
    if degraded and minutes_ago <= degraded[0]:
        factor, add_ms = degraded[1], degraded[2]
    lossy = LOSSY.get(name)
    if lossy and minutes_ago <= lossy[0]:
        loss_p, factor = lossy[1], max(factor, 1.6)
    utc = store.as_utc(ts)
    if utc.weekday() < 5 and 7 <= utc.hour < 18:
        factor *= 1.12   # business hours: slightly busier control planes
    rtts = []
    for _ in range(pings):
        if rnd.random() < loss_p:
            continue
        value = base * factor + add_ms + abs(rnd.gauss(0.0, jitter * factor))
        if rnd.random() < 0.01:
            value *= rnd.uniform(3.0, 8.0)   # occasional control-plane spike
        rtts.append(value)
    if not rtts:
        return lost
    avg = stats.mean(rtts)
    mdev = math.sqrt(sum((v - avg) ** 2 for v in rtts) / len(rtts))
    return Sample(
        device_id=device_id, ts=ts,
        rtt_avg_ms=round(avg, 3), rtt_min_ms=round(min(rtts), 3), rtt_max_ms=round(max(rtts), 3),
        jitter_ms=round(mdev, 3), loss_pct=round((pings - len(rtts)) * 100.0 / pings, 2), sent=pings,
    )


# ─── Demo enrichment: seed steps ──────────────────────────────────────────────

def ports_of_device(db: Session, dev: Device) -> list[Port]:
    return db.query(Port).filter(Port.device_id == dev.id).order_by(Port.if_index).all()


def weighted_choice(options: list[tuple[str, int]]) -> str:
    return rng.choices([k for k, _ in options], weights=[w for _, w in options], k=1)[0]


def create_switch_models(db: Session) -> dict[str, SwitchModel]:
    models = {}
    for name, ppr, total, descr in SWITCH_MODEL_DEFS:
        sm = SwitchModel(name=name, ports_per_row=ppr, total_ports=total, description=descr)
        db.add(sm)
        models[name] = sm
    db.flush()
    return models


def add_ap_wireless_ports(db: Session, devices_by_rack: dict) -> None:
    """Wireless VAP interfaces on each AP; client MACs are learned there."""
    for rack in RACKS:
        ap = devices_by_rack[rack["id"]]["ap"]
        db.add(Port(device_id=ap.id, if_index=2, if_descr="wifi0", if_alias="SSID corp (5 GHz)",
                    speed_mbps=2_400, oper_status=1, vlan=20, tagged_vlans=[]))
        db.add(Port(device_id=ap.id, if_index=3, if_descr="wifi1", if_alias="SSID guest (2.4/5 GHz)",
                    speed_mbps=1_200, oper_status=1, vlan=99, tagged_vlans=[]))


def firmware_for(dev: Device) -> str:
    old = FIRMWARE_DRIFT_RACK in (dev.sys_name or "")
    if dev.vendor == "fs":
        return "FSOS 9.1.4" if old else "FSOS 9.2.1"
    if dev.vendor == "aruba_cx":
        prefix = "ML" if dev.model == ARUBA_CX_6200["model"] else "FL"
        return f"{prefix}.10.12.1030" if old else f"{prefix}.10.13.1010"
    if dev.vendor == "unifi":
        return (dev.sys_descr or "").rsplit(" ", 1)[-1]
    return ""


def enrich_devices(db: Session, devices: list[Device], models_by_name: dict, now: datetime) -> None:
    last_scan = now - timedelta(minutes=SCAN_SCHEDULE[0][0])
    last_discovery = now - timedelta(minutes=min(m for m, kind in SCAN_SCHEDULE if kind == "discovery"))
    last_vlan_stp = now - timedelta(minutes=64)
    for dev in devices:
        base, _ = latency_profile(dev.sys_name, dev.vendor)
        dev.firmware = firmware_for(dev)
        if dev.vendor == "fs" and dev.firmware != "FSOS 9.2.1":
            dev.sys_descr = dev.sys_descr.replace("FSOS 9.2.1", dev.firmware)
        model = models_by_name.get(dev.model)
        dev.model_id = model.id if model else None
        dev.latency_monitored = True
        dev.last_ping = last_scan
        outage = ongoing_outage_start(dev.sys_name)
        if outage is None:
            dev.ping_status = "online"
            dev.ping_rtt_ms = max(1, round(base * 1.3))
            dev.last_seen = last_scan
        else:
            dev.ping_status = "offline"
            dev.ping_rtt_ms = 0
            dev.last_seen = now - timedelta(minutes=outage)
        dev.if_names = {str(p.if_index): [p.if_descr or "", p.if_alias or ""] for p in ports_of_device(db, dev)}
        dev.if_names_at = min(last_discovery, dev.last_seen)
        dev.vlan_at = min(last_vlan_stp, dev.last_seen)
        dev.stp_at = None if dev.vendor == "unifi" else dev.vlan_at


class EndpointFactory:
    """Unique MACs, per-VLAN IP allocation and hostnames for demo endpoints."""

    def __init__(self) -> None:
        self.macs: set[str] = set()
        self.next_host: dict[int, int] = {}
        self.counters: dict[str, int] = {}

    def mac(self, kind: str) -> str:
        while True:
            if kind == "random":
                mac = rng.choice(RANDOM_MAC_FIRST_OCTETS) + "".join(f":{rng.randint(0, 255):02x}" for _ in range(5))
            else:
                mac = rng.choice(ENDPOINT_OUIS[kind]) + "".join(f":{rng.randint(0, 255):02x}" for _ in range(3))
            if mac not in self.macs:
                self.macs.add(mac)
                return mac

    def ip(self, vlan: int, kind: str) -> str | None:
        if kind not in ("server", "esx", "vm", "storage", "bmc") and rng.random() < 0.05:
            return None   # silent host: MAC learned, no ARP entry
        host = self.next_host.get(vlan, 20)
        if host > 250:
            return None
        self.next_host[vlan] = host + 1
        return f"10.10.{vlan}.{host}"

    def _n(self, key: str) -> int:
        self.counters[key] = self.counters.get(key, 0) + 1
        return self.counters[key]

    def hostname(self, kind: str, room: str) -> str | None:
        if kind in ("dell_pc", "lenovo_pc", "hp_pc"):
            return f"ws-{rng.choice(DEPARTMENTS)}-{self._n('ws'):03d}"
        if kind == "apple":
            return f"mac-{rng.choice(DEPARTMENTS)}-{self._n('mac'):02d}"
        if kind == "intel_wifi":
            return f"nb-{rng.choice(DEPARTMENTS)}-{self._n('nb'):03d}"
        if kind == "phone":
            ext = 2100 + self._n("phone")
            return f"sip-{ext}" if rng.random() < 0.6 else None
        if kind in ("server", "vm"):
            return f"{'srv' if kind == 'server' else 'vm'}-{rng.choice(SERVER_ROLES)}-{self._n(kind):02d}"
        if kind == "esx":
            return f"esx-{self._n('esx'):02d}"
        if kind == "bmc":
            return f"bmc-srv-{self._n('bmc'):02d}"
        if kind in ("printer", "ups", "pdu", "camera"):
            prefix = {"printer": "prn", "ups": "ups", "pdu": "pdu", "camera": "cam"}[kind]
            return f"{prefix}-{room}-{self._n(kind + room):02d}"
        if kind == "storage":
            return f"nas-{self._n('nas'):02d}"
        return None


def seed_endpoints(db: Session, devices_by_rack: dict, now: datetime) -> dict:
    """Endpoints on access ports and AP wireless ports, plus some history."""
    fac = EndpointFactory()
    counts = {"endpoints": 0, "associations": 0, "history": 0, "inactive": 0}
    created: list[tuple[Endpoint, str, Port]] = []
    aruba_access_ports: list[Port] = []

    def add(kind: str, port: Port, vlan: int, dev: Device, room: str,
            seen_at: datetime | None = None) -> Endpoint:
        # Columns are naive timestamps (UTC); reloaded values come back naive.
        seen_at = store.as_utc(seen_at or dev.last_seen)
        max_age_min = DEVICE_ADDED.get(dev.sys_name, 60 * 24 * 60)
        first_seen = min(seen_at, now - timedelta(minutes=rng.uniform(90, max_age_min)))
        ep = Endpoint(mac=fac.mac(kind), ip=fac.ip(vlan, kind), hostname=fac.hostname(kind, room),
                      first_seen=first_seen, last_seen=seen_at, ignored=False)
        ep.port_associations.append(EndpointPortAssociation(port_id=port.id, vlan_id=vlan, last_seen=seen_at))
        db.add(ep)
        created.append((ep, kind, port))
        counts["endpoints"] += 1
        counts["associations"] += 1
        return ep

    for rack in RACKS:
        d = devices_by_rack[rack["id"]]
        room = rack["room"].lower()
        for key in ("fs1", "fs2", "aruba1", "aruba2", "aruba3"):
            dev = d[key]
            is_fs = dev.vendor == "fs"
            for port in ports_of_device(db, dev):
                if not (port.if_alias or "").startswith("access") or port.tagged_vlans:
                    continue
                if not is_fs:
                    aruba_access_ports.append(port)
                if port.oper_status != 1 or rng.random() >= (0.18 if is_fs else 0.36):
                    continue
                vlan = port.vlan
                kind = weighted_choice(VLAN_ENDPOINT_KINDS.get(vlan, DESK_KINDS))
                add(kind, port, vlan, dev, room)
                if kind == "esx":
                    for _ in range(rng.randint(2, 4)):
                        add("vm", port, vlan, dev, room)
                elif kind == "phone" and rng.random() < 0.5:
                    add(weighted_choice(DESK_KINDS), port, 20, dev, room)   # PC behind the phone
                if kind in LOW_SPEED_KINDS:
                    port.speed_mbps = 1_000 if is_fs else 100
                elif is_fs and kind in ("server", "esx", "storage") and rng.random() < 0.4:
                    port.speed_mbps = 10_000
                if port.stp_path_cost is not None:
                    port.stp_path_cost = STP_PATH_COST.get(port.speed_mbps, 20_000)

        ap = d["ap"]
        wifi = {p.if_descr: p for p in ports_of_device(db, ap)}
        for _ in range(rng.randint(6, 10)):
            add(weighted_choice(WIRELESS_CORP_KINDS), wifi["wifi0"], 20, ap, room)
        for _ in range(rng.randint(2, 5)):
            add("random", wifi["wifi1"], 99, ap, room)

    # Moved endpoints: an older association on another access port.
    movable = [(ep, port) for ep, kind, port in created
               if kind in ("dell_pc", "lenovo_pc", "hp_pc", "apple") and not port.if_descr.startswith("wifi")]
    for ep, port in rng.sample(movable, min(20, len(movable))):
        old_port = rng.choice([p for p in aruba_access_ports if p.id != port.id])
        old_seen = now - timedelta(days=rng.uniform(1.0, 6.0))
        ep.port_associations.append(EndpointPortAssociation(port_id=old_port.id, vlan_id=20, last_seen=old_seen))
        ep.first_seen = min(store.as_utc(ep.first_seen), old_seen - timedelta(days=1))
        counts["associations"] += 1
        counts["history"] += 1

    # Inactive endpoints: last seen days ago on ports that are down now.
    down_ports = [p for p in aruba_access_ports if p.oper_status != 1]
    dev_by_id = {devices_by_rack[r["id"]][k].id: (devices_by_rack[r["id"]][k], r["room"].lower())
                 for r in RACKS for k in ("aruba1", "aruba2", "aruba3")}
    for port in rng.sample(down_ports, min(12, len(down_ports))):
        dev, room = dev_by_id[port.device_id]
        add(weighted_choice([*DESK_KINDS, ("printer", 1)]), port, 20, dev, room,
            seen_at=now - timedelta(days=rng.uniform(2.0, 6.0)))
        counts["inactive"] += 1

    # A few curated flags and notes.
    guests = [ep for ep, kind, _ in created if kind == "random"]
    for ep in guests[:3]:
        ep.ignored = True
        ep.notes = "Guest device with randomized MAC, ignored"
    notes = {"printer": "Floor printer, toner managed by facilities",
             "ups": "UPS feed A, battery replaced last quarter",
             "storage": "Primary NAS, snapshots every 4 h",
             "esx": "Hypervisor host, VMs on vSwitch0"}
    for ep, kind, _ in created:
        if kind in notes and ep.notes is None:
            ep.notes = notes.pop(kind)
    db.flush()
    return counts


def upsert_settings(db: Session, values: dict[str, str]) -> None:
    for key, value in values.items():
        row = db.query(AppSetting).filter(AppSetting.key == key).first()
        if row is None:
            db.add(AppSetting(key=key, value=value))
        else:
            row.value = value


def seed_users(db: Session) -> dict[str, User]:
    """Create the demo users; returns all users of interest by username (incl. admin)."""
    from shared.auth import hash_password

    users = {}
    for username, role, email in DEMO_USERS:
        user = User(username=username, email=email, hashed_pw=hash_password(DEMO_PASSWORD),
                    role=role, is_active=True)
        db.add(user)
        users[username] = user
    db.flush()
    admin = db.query(User).filter(User.username == "admin").first()
    if admin is not None:
        users["admin"] = admin
    return users


def _link_key(link: TopologyLink) -> str:
    # Same format as scan_engine.db_helpers._canonical_link_key (not imported:
    # the scan_engine package pulls in the SNMP stack).
    return f"{link.local_ip}|{link.local_port}|{link.remote_ip}|{link.remote_port}"


def seed_scan_runs(db: Session, devices: list[Device], cred_by_ip: dict, now: datetime,
                   profile_by_vendor: dict) -> list[dict]:
    """Scan history oldest first; returns run descriptors for logs and audit."""
    links = db.query(TopologyLink).all()
    runs = []
    for minutes_ago, kind in sorted(SCAN_SCHEDULE, reverse=True):
        finished = now - timedelta(minutes=minutes_ago)
        is_dry = kind == "dry_run"
        lo, hi = SCAN_DURATION_MS["discovery" if is_dry else kind]
        present = [d for d in devices if device_exists(d.sys_name, minutes_ago)]
        ok_ips = {d.ip for d in present if not in_outage(d.sys_name, minutes_ago)}
        metrics = []   # (ip, label, duration_ms, success, error)
        for dev in present:
            cred = cred_by_ip.get(dev.ip)
            label = cred.label if cred else dev.sys_name
            if dev.ip in ok_ips:
                ms = rng.randint(lo, hi)
                if kind == "macs" and dev.model == ARUBA_CX_6200["model"]:
                    ms *= 2   # 48-port FDB walk
                metrics.append((dev.ip, label, ms, True, ""))
            else:
                metrics.append((dev.ip, label, rng.randint(6000, 6150), False, SCAN_TIMEOUT_ERROR))
        preview = []
        if is_dry:
            for dev in present:
                preview.append({
                    "ip": dev.ip, "sys_name": dev.sys_name, "sys_descr": dev.sys_descr,
                    "vendor": dev.vendor, "location": dev.location, "firmware": dev.firmware,
                    "matched_profile_id": profile_by_vendor.get(dev.vendor), "already_exists": True,
                })
            for host in DRY_RUN_NEW_HOSTS:
                preview.append({**host, "matched_profile_id": profile_by_vendor.get(host["vendor"]),
                                "already_exists": False})
                metrics.append((host["ip"], host["ip"], rng.randint(lo, hi), True, ""))
            preview.append({
                "ip": DRY_RUN_NO_PROFILE_IP, "sys_name": "", "sys_descr": "", "vendor": "unknown",
                "location": "", "firmware": "", "matched_profile_id": None, "already_exists": False,
                "no_profile_suitable": True,
            })
        metrics.sort(key=lambda m: m[2], reverse=True)
        durations = [m[2] for m in metrics]
        total_ms = int(max(max(durations), sum(durations) / min(SCAN_MAX_WORKERS, len(durations))))
        total_ms += rng.randint(400, 1200) + (28_000 if is_dry else 0)   # dry run: range ping sweep
        range_probes = len(DISCOVERY_RANGES) * 254 if is_dry else 0
        link_keys = sorted({_link_key(lk) for lk in links if lk.local_ip in ok_ips and lk.remote_ip in ok_ips})
        failed = [m for m in metrics if not m[3]]
        # A real dry run stores empty snapshots; the demo keeps the full
        # snapshot so the run history diff stays meaningful.
        run = ScanRun(
            status="dry_run" if is_dry else "finished",
            scanned=len(present) + range_probes,
            found=len(ok_ips) + (len(DRY_RUN_NEW_HOSTS) if is_dry else 0),
            links=0 if is_dry else len(link_keys),
            max_workers=SCAN_MAX_WORKERS,
            total_duration_ms=total_ms,
            error_count=len(failed),
            devices_snapshot_json=json.dumps(sorted(ok_ips)),
            links_snapshot_json=json.dumps(link_keys),
            created_at=finished,
        )
        db.add(run)
        db.flush()
        for ip, label, ms, success, error in metrics:
            db.add(ScanRunSwitchMetric(scan_run_id=run.id, ip=ip, label=label, duration_ms=ms,
                                       success=success, error=error))
        if is_dry:
            db.add(DryRunResult(scan_run_id=run.id, preview_json=preview, created_at=finished))
        runs.append({
            "id": run.id, "kind": kind, "finished": finished, "total_ms": total_ms,
            "correlation_id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
            "credentials": len(present), "range_probes": range_probes, "status": run.status,
            "scanned": run.scanned, "found": run.found, "links": run.links, "failed": failed,
            "minutes_ago": minutes_ago,
        })
    return runs


def seed_audit_logs(db: Session, now: datetime, users: dict[str, User], ctx: dict) -> int:
    """Audit entries using the action/resource names the routers write."""
    racks, profiles, classes, models = ctx["racks"], ctx["profiles"], ctx["classes"], ctx["models"]
    devices, creds, runs = ctx["devices"], ctx["credentials"], ctx["runs"]
    run_by_kind_age = {(r["kind"], r["minutes_ago"]): r for r in runs}
    dry = next(r for r in runs if r["kind"] == "dry_run")
    first = runs[0]
    replaced = devices["aruba-rack-d-acc1"]
    replaced_cred = creds[replaced.ip]
    after_maint = run_by_kind_age[("discovery", 1800)]
    endpoint_ids = [row.id for row in db.query(Endpoint.id).order_by(Endpoint.id).limit(5).all()]
    interval_keys = ["discovery_interval_sec", "link_update_interval_sec", "mac_update_interval_sec"]

    entries = [   # (minutes ago, username, action, resource, resource_id, details)
        (7180, "admin", "create", "user", users["operator"].id, {"username": "operator", "role": "operator"}),
        (7176, "admin", "create", "user", users["viewer"].id, {"username": "viewer", "role": "viewer"}),
        (7172, "admin", "create", "user", users["noc-admin"].id, {"username": "noc-admin", "role": "admin"}),
        (7000, "admin", "settings_change", "discovery_ranges", "", {"ranges": DISCOVERY_RANGES}),
        (6995, "admin", "settings_change", "dns_settings", "", {"servers": DNS_SERVERS}),
        *[(6900 - i, "admin", "create", "snmp_profile", p.id, {"label": p.label}) for i, p in enumerate(profiles)],
        (6850, "noc-admin", "import", "bulk_credentials", "", {"inserted": 29, "updated": 0, "total_rows": 29}),
        *[(6800 - i, "admin", "create", "switch_class", c.id, {"label": c.label}) for i, c in enumerate(classes)],
        *[(6700 - i, "admin", "create", "rack", r.id, {"label": r.label}) for i, r in enumerate(racks)],
        *[(6600 - i, "admin", "create", "switch_model", m.id, {"name": m.name}) for i, m in enumerate(models[:3])],
        (first["minutes_ago"] + 2, "admin", "scan", "scan_job", first["correlation_id"], {"mode": "background"}),
        (2878, "operator", "create", "credential", creds[devices["ap-rack-e-01"].ip].id,
         {"ip": devices["ap-rack-e-01"].ip, "label": creds[devices["ap-rack-e-01"].ip].label}),
        (2870, "operator", "update", "device_meta", devices["ap-rack-e-01"].id, {"fields": ["label", "class_id"]}),
        (2190, "noc-admin", "update", "device_meta", replaced.id, {"fields": ["enabled"]}),
        (2140, "noc-admin", "update", "device_meta", replaced.id, {"fields": ["enabled"]}),
        (after_maint["minutes_ago"], "system", "engine_id_changed", "credential", replaced_cred.id,
         {"ip": replaced.ip, "old": "800009c30302a0c9040300", "new": "800009c303ecebb8a1f2c0",
          "correlation_id": after_maint["correlation_id"]}),
        (1720, "noc-admin", "update", "credential", replaced_cred.id,
         {"fields": ["v3_auth_password", "v3_priv_password"]}),
        (1500, "admin", "settings_change", "scan_settings", "", {"max_workers": SCAN_MAX_WORKERS}),
        (dry["minutes_ago"] + 1, "admin", "scan", "scan_job", dry["correlation_id"], {"mode": "background"}),
        (960, "operator", "update", "rack_layout", racks[4].id,
         {"device_ids": [devices[f"{n}-rack-e-{s}"].id for n, s in
                         (("fs", "tor1"), ("fs", "tor2"), ("aruba", "acc1"), ("aruba", "acc2"), ("aruba", "acc3"))]}),
        (930, "operator", "bulk_update", "endpoint", "", {"endpoint_ids": endpoint_ids[:3], "fields": ["ignored"]}),
        (925, "operator", "update", "endpoint", endpoint_ids[3], {"fields": ["notes"]}),
        (720, "operator", "update", "rack", racks[2].id, {"fields": ["description"]}),
        (480, "noc-admin", "update", "snmp_profile", profiles[1].id, {"fields": ["v3_username"]}),
        (300, "admin", "update", "switch_class", classes[2].id, {"fields": ["color"]}),
        (190, "operator", "bulk_update", "device_meta", "",
         {"device_ids": [devices["aruba-rack-e-acc2"].id], "fields": ["latency_monitored"]}),
        (95, "admin", "settings_change", "app_setting", "latency_interval_sec", {"value": "10"}),
        (40, "operator", "update", "device_meta", devices["ap-rack-b-01"].id, {"fields": ["label"]}),
        (3, "admin", "settings_change", "app_setting", ",".join(interval_keys),
         {"keys": interval_keys, "values": {key: "0" for key in interval_keys}}),
    ]
    for minutes_ago, username, action, resource, resource_id, details in entries:
        user = users.get(username)
        db.add(AuditLog(
            timestamp=now - timedelta(minutes=minutes_ago, seconds=rng.randint(0, 50)),
            user_id=user.id if user is not None else None,
            username=username,
            action=action,
            resource=resource,
            resource_id=str(resource_id),
            details=details,
        ))
    return len(entries)


def seed_latency_history(db: Session, devices: list[Device], now: datetime) -> int:
    """Minute rollups for the last 24 h, one rollup per 15 min for days 2-7."""
    current = store.minute_floor(now)
    full_res_start = current - timedelta(hours=24)
    oldest = current - timedelta(days=HISTORY_DAYS)
    oldest = oldest.replace(minute=oldest.minute - oldest.minute % HISTORY_COARSE_STEP_MIN)
    buckets = []
    t = oldest
    while t < full_res_start:
        buckets.append(t)
        t += timedelta(minutes=HISTORY_COARSE_STEP_MIN)
    t = full_res_start
    while t < current:   # the current minute is written by the monitor round
        buckets.append(t)
        t += timedelta(minutes=1)

    total = 0
    batch: list[dict] = []
    for dev in devices:
        base, jitter = latency_profile(dev.sys_name, dev.vendor)
        for bucket in buckets:
            minutes_ago = (now - bucket).total_seconds() / 60.0
            if not device_exists(dev.sys_name, minutes_ago):
                continue
            samples = [simulate_sample(dev.id, dev.sys_name, base, jitter, bucket + timedelta(seconds=10 * i),
                                       minutes_ago, DEFAULT_PINGS, rng) for i in range(SAMPLES_PER_MINUTE)]
            batch.append(store.build_rollup(dev.id, bucket, samples))
            if len(batch) >= 5000:
                db.execute(insert(LatencySample), batch)
                total += len(batch)
                batch = []
    if batch:
        db.execute(insert(LatencySample), batch)
        total += len(batch)
    return total


def _log_entry(ts: datetime, level: str, event: str, **fields) -> dict:
    # Same payload shape as shared.state._log_event.
    return {"ts": ts.isoformat(), "level": level, "event": event, **fields}


def build_log_entries(runs: list[dict], now: datetime) -> list[dict]:
    """Structured backend log lines for the scan history, oldest first."""
    entries = [_log_entry(runs[0]["finished"] - timedelta(hours=2), "INFO", "latency_monitor_started")]
    for run in runs:
        started = run["finished"] - timedelta(milliseconds=run["total_ms"])
        corr = run["correlation_id"]
        if run["kind"] == "dry_run":
            entries.append(_log_entry(started - timedelta(milliseconds=250), "INFO", "scan.job.start",
                                      correlation_id=corr, job_id=corr, dry_run=True, backend="celery"))
            scan_type = "full"
        else:
            scan_type = run["kind"]
            entries.append(_log_entry(started - timedelta(milliseconds=400), "INFO", f"scheduler.{scan_type}.start"))
            entries.append(_log_entry(started - timedelta(milliseconds=380), "INFO",
                                      f"scheduler.{scan_type}.dispatched", backend="celery"))
        entries.append(_log_entry(started, "INFO", "scan.start", correlation_id=corr, scan_type=scan_type,
                                  enabled_credentials=run["credentials"], range_probes=run["range_probes"],
                                  configured_max_workers=SCAN_MAX_WORKERS))
        for ip, label, ms, _, error in run["failed"]:
            entries.append(_log_entry(started + timedelta(milliseconds=ms), "WARNING", "scan.switch.result",
                                      correlation_id=corr, ip=ip, label=label, success=False, ping_ok=False,
                                      ping_rtt_ms=0, duration_ms=ms, error=error, range_probe=False))
        entries.append(_log_entry(run["finished"], "INFO", "scan.end", correlation_id=corr, status=run["status"],
                                  scanned=run["scanned"], found=run["found"], links=run["links"],
                                  total_duration_ms=run["total_ms"], errors=len(run["failed"]), run_id=run["id"]))
    entries.sort(key=lambda e: e["ts"])
    return entries


def write_log_buffer(r, entries: list[dict]) -> None:
    """Replace net2map:logs (newest first via LPUSH, trimmed like _log_event)."""
    pipe = r.pipeline()
    pipe.delete("net2map:logs")
    for entry in entries:
        pipe.lpush("net2map:logs", json.dumps(entry, default=str))
    pipe.ltrim("net2map:logs", 0, 4999)
    pipe.execute()
    print(f"  [OK] {len(entries)} structured log entries written to net2map:logs")


# ─── Main seed routine ────────────────────────────────────────────────────────

def seed(db: Session):
    print("Clearing existing data ...")
    # FK-safe order: children before parents. The migration-seeded "admin"
    # user is kept; only the demo users of this script are removed.
    db.query(EndpointPortAssociation).delete(synchronize_session=False)
    db.query(Endpoint).delete(synchronize_session=False)
    db.query(LatencySample).delete(synchronize_session=False)
    db.query(DryRunResult).delete(synchronize_session=False)
    db.query(ScanRunSwitchMetric).delete(synchronize_session=False)
    db.query(ScanRun).delete(synchronize_session=False)
    db.query(AuditLog).delete(synchronize_session=False)
    db.query(TopologyLink).delete()
    db.query(Port).delete()
    db.query(Device).delete()
    db.query(Credential).delete()
    db.query(SnmpProfile).delete()
    db.query(SwitchClass).delete()
    db.query(RackModel).delete()
    db.query(SwitchModel).delete(synchronize_session=False)
    db.query(User).filter(
        User.username.in_([name for name, _, _ in DEMO_USERS]),
        User.username != "admin",
    ).delete(synchronize_session=False)
    db.commit()
    now = datetime.now(timezone.utc)

    # ── 0. Global SNMP Profiles ─────────────────────────────────────────────────────
    print("Creating SNMP profiles …")
    prof_fs = SnmpProfile(
        label              = "FS TOR – SNMPv3 authPriv",
        snmp_version       = "v3",
        community          = "public",
        v3_security_level  = "authPriv",
        v3_username        = "netmon_fs_global",
        v3_auth_protocol   = "SHA-256",
        v3_auth_password   = "CHANGEME_auth",
        v3_priv_protocol   = "AES-256",
        v3_priv_password   = "CHANGEME_priv",
    )
    prof_aruba = SnmpProfile(
        label              = "Aruba CX – SNMPv3 authPriv",
        snmp_version       = "v3",
        community          = "public",
        v3_security_level  = "authPriv",
        v3_username        = "netmon_aruba_global",
        v3_auth_protocol   = "SHA-256",
        v3_auth_password   = "CHANGEME_auth",
        v3_priv_protocol   = "AES-128",
        v3_priv_password   = "CHANGEME_priv",
    )
    db.add(prof_fs)
    db.add(prof_aruba)
    db.flush()   # assigns IDs
    print(f"  [OK] Profile [{prof_fs.id}]: {prof_fs.label}")
    print(f"  [OK] Profile [{prof_aruba.id}]: {prof_aruba.label}")

    # ── 0b. Default Switch Classes ──────────────────────────────────────────
    print("Creating switch classes …")
    cls_tor = SwitchClass(label="Top of Rack",  color="#22d3ee", description="Top-of-Rack aggregation switches")
    cls_acc = SwitchClass(label="Access",        color="#22c55e", description="Access-layer switches")
    cls_agg = SwitchClass(label="Aggregation",   color="#f59e0b", description="Distribution / aggregation switches")
    cls_cor = SwitchClass(label="Core",          color="#8b5cf6", description="Core / backbone switches")
    cls_ap  = SwitchClass(label="Access Point",  color="#ec4899", description="Wireless access points",
                         allow_outside_rack=True)
    for sc in [cls_tor, cls_acc, cls_agg, cls_cor, cls_ap]:
        db.add(sc)
    db.flush()
    print(f"  [OK] Classes: {cls_tor.label}, {cls_acc.label}, {cls_agg.label}, {cls_cor.label}, {cls_ap.label}")

    # ── 0c. Managed Racks ───────────────────────────────────────────────────
    print("Creating managed racks …")
    managed_racks: dict[str, RackModel] = {}
    for ri, rack in enumerate(RACKS):
        mr = RackModel(label=rack["label"], room=rack["room"],
                       map_x=RACK_CENTERS[ri][0], map_y=RACK_CENTERS[ri][1])
        db.add(mr)
        db.flush()
        managed_racks[rack["id"]] = mr
        print(f"  [OK] Rack [{mr.id}]: {mr.label} / {mr.room}")

    devices_by_rack: dict[str, dict] = {}  # rack_id → {fs1, fs2, aruba1, aruba2, aruba3}

    # ── 1. Devices + Ports ───────────────────────────────────────────────────
    cred_counter = 0
    for ri, rack in enumerate(RACKS):
        cx, cy = RACK_CENTERS[ri]
        rack_id = rack["id"]
        location = f"{rack['label']} / {rack['room']}"
        devices_by_rack[rack_id] = {}

        def make_ip(slot: int) -> str:
            # Management IP: 192.168.<rack>.<slot>
            return f"192.168.{ri+1}.{slot+1}"

        # ── FS TOR-1 ────────────────────────────────────────────────────────
        ox, oy = CLUSTER_OFFSETS[0]
        mr = managed_racks[rack_id]  # managed Rack record for FK assignment

        fs1 = Device(
            sys_name  = f"fs-{rack_id}-tor1",
            ip        = make_ip(0),
            sys_descr = FS_DESCR,
            model     = FS_MODEL,
            vendor    = "fs",
            location  = location,
            map_x     = cx + ox,
            map_y     = cy + oy,
            rack_id   = mr.id,
            rack_u_position = RACK_U_POSITIONS[0],
            class_id  = cls_tor.id,
            label     = f"{rack['label']} TOR-1 -- {FS_MODEL}",
            enabled   = True,
        )
        db.add(fs1)
        db.flush()
        for p in make_fs_ports(fs1.id, ri, 0):
            db.add(p)

        # ── FS TOR-2 ────────────────────────────────────────────────────────
        ox, oy = CLUSTER_OFFSETS[1]
        fs2 = Device(
            sys_name  = f"fs-{rack_id}-tor2",
            ip        = make_ip(1),
            sys_descr = FS_DESCR,
            model     = FS_MODEL,
            vendor    = "fs",
            location  = location,
            map_x     = cx + ox,
            map_y     = cy + oy,
            rack_id   = mr.id,
            rack_u_position = RACK_U_POSITIONS[1],
            class_id  = cls_tor.id,
            label     = f"{rack['label']} TOR-2 -- {FS_MODEL}",
            enabled   = True,
        )
        db.add(fs2)
        db.flush()
        for p in make_fs_ports(fs2.id, ri, 1):
            db.add(p)

        # ── Aruba CX-1  (6300M → TOR-1) ──────────────────────────────────
        ox, oy = CLUSTER_OFFSETS[2]
        aruba1 = Device(
            sys_name  = f"aruba-{rack_id}-acc1",
            ip        = make_ip(2),
            rack_u_position = RACK_U_POSITIONS[2],
            sys_descr = ARUBA_CX_6300["descr"],
            model     = ARUBA_CX_6300["model"],
            vendor    = "aruba_cx",
            location  = location,
            map_x     = cx + ox,
            map_y     = cy + oy,
            rack_id   = mr.id,
            class_id  = cls_acc.id,
            label     = f"{rack['label']} ACC-1 -- {ARUBA_CX_6300['model']}",
            enabled   = True,
        )
        db.add(aruba1)
        db.flush()
        for p in make_aruba_6300_ports(aruba1.id, ri, 2):
            db.add(p)

        # ── Aruba CX-2  (6300M → TOR-1) ──────────────────────────────────
        ox, oy = CLUSTER_OFFSETS[3]
        aruba2 = Device(
            sys_name  = f"aruba-{rack_id}-acc2",
            ip        = make_ip(3),
            rack_u_position = RACK_U_POSITIONS[3],
            sys_descr = ARUBA_CX_6300["descr"],
            model     = ARUBA_CX_6300["model"],
            vendor    = "aruba_cx",
            location  = location,
            map_x     = cx + ox,
            map_y     = cy + oy,
            rack_id   = mr.id,
            class_id  = cls_acc.id,
            label     = f"{rack['label']} ACC-2 -- {ARUBA_CX_6300['model']}",
            enabled   = True,
        )
        db.add(aruba2)
        db.flush()
        for p in make_aruba_6300_ports(aruba2.id, ri, 3):
            db.add(p)

        # ── Aruba CX-3  (6200F → TOR-2) ──────────────────────────────────
        ox, oy = CLUSTER_OFFSETS[4]
        aruba3 = Device(
            sys_name  = f"aruba-{rack_id}-acc3",
            ip        = make_ip(4),
            rack_u_position = RACK_U_POSITIONS[4],
            sys_descr = ARUBA_CX_6200["descr"],
            model     = ARUBA_CX_6200["model"],
            vendor    = "aruba_cx",
            location  = location,
            map_x     = cx + ox,
            map_y     = cy + oy,
            rack_id   = mr.id,
            class_id  = cls_acc.id,
            label     = f"{rack['label']} ACC-3 -- {ARUBA_CX_6200['model']}",
            enabled   = True,
        )
        db.add(aruba3)
        db.flush()
        for p in make_aruba_6200_ports(aruba3.id, ri, 4):
            db.add(p)

        # ── UniFi AP  (outside rack — class allows it) ─────────────────────
        ap_tpl = AP_MODELS[ri % len(AP_MODELS)]
        ap = Device(
            sys_name  = f"ap-{rack_id}-01",
            ip        = make_ip(99),        # 192.168.<rack>.100
            sys_descr = ap_tpl["descr"],
            model     = ap_tpl["model"],
            vendor    = "unifi",
            location  = f"{location} / ceiling",
            map_x     = cx + AP_OFFSETS[ri][0],
            map_y     = cy + AP_OFFSETS[ri][1],
            rack_id   = None,               # outside-rack placement
            class_id  = cls_ap.id,
            label     = f"{rack['label']} AP -- {ap_tpl['model']}",
            enabled   = True,
        )
        db.add(ap)
        db.flush()
        db.add(Port(
            device_id   = ap.id,
            if_index    = 1,
            if_descr    = "eth0",
            if_alias    = "uplink",
            speed_mbps  = 2_500,
            oper_status = 1,
            vlan        = 1,
        ))

        devices_by_rack[rack_id] = {
            "fs1": fs1, "fs2": fs2,
            "aruba1": aruba1, "aruba2": aruba2, "aruba3": aruba3,
            "ap": ap,
        }

        # ── Credentials ─────────────────────────────────────────────────────
        db.add(Credential(
            label        = f"{rack['label']} AP -- {ap.model}",
            ip           = ap.ip,
            snmp_port    = 161,
            enabled      = True,
            device_id    = ap.id,
            profile_id   = None,
            snmp_version = "v2c",
            community    = "public",
        ))
        cred_counter += 1

        for sw, role in [(fs1,"TOR-1"),(fs2,"TOR-2"),(aruba1,"ACC-1"),(aruba2,"ACC-2"),(aruba3,"ACC-3")]:
            is_fs = sw.vendor == "fs"
            db.add(Credential(
                label             = f"{rack['label']} {role} -- {sw.model}",
                ip                = sw.ip,
                snmp_port         = 161,
                enabled           = True,
                device_id         = sw.id,
                profile_id        = prof_fs.id if is_fs else prof_aruba.id,
                snmp_version      = "v3",
                community         = "public",
                v3_security_level = "authPriv",
                v3_username       = f"netmon_{sw.sys_name.replace('-','_')}",
                v3_auth_protocol  = "SHA-256",
                v3_auth_password  = "CHANGEME_auth",
                v3_priv_protocol  = "AES-256" if is_fs else "AES-128",
                v3_priv_password  = "CHANGEME_priv",
            ))
            cred_counter += 1

        db.commit()
        print(f"  [OK] {rack['label']}: fs1={fs1.ip}, fs2={fs2.ip}, "
              f"aruba1={aruba1.ip}, aruba2={aruba2.ip}, aruba3={aruba3.ip}")

    # ── 2. Topology Links ────────────────────────────────────────────────────
    print("Building topology links …")
    links_added = 0

    def add_link(local_dev, local_port_desc,
                 remote_dev, remote_port_desc, speed):
        nonlocal links_added
        # local → remote
        db.add(TopologyLink(
            local_ip     = local_dev.ip,
            local_port   = local_port_desc,
            remote_ip    = remote_dev.ip,
            remote_sys   = remote_dev.sys_name,
            remote_port  = remote_port_desc,
            speed_label  = speed,
        ))
        # remote → local (LLDP is bidirectional)
        db.add(TopologyLink(
            local_ip     = remote_dev.ip,
            local_port   = remote_port_desc,
            remote_ip    = local_dev.ip,
            remote_sys   = local_dev.sys_name,
            remote_port  = local_port_desc,
            speed_label  = speed,
        ))
        links_added += 2

    for ri, rack in enumerate(RACKS):
        d = devices_by_rack[rack["id"]]
        fs1, fs2 = d["fs1"], d["fs2"]
        a1, a2, a3 = d["aruba1"], d["aruba2"], d["aruba3"]

        # FS TOR-1 ↔ FS TOR-2  (inter-TOR trunk via QSFP port 21)
        add_link(fs1, "HundredGigE1/1", fs2, "HundredGigE1/1", "100G")

        # Aruba ACC-1 uplink → FS TOR-1 (port 1)
        add_link(a1, "1/1/25", fs1, "Eth1/1", "10G")

        # Aruba ACC-2 uplink → FS TOR-1 (port 2)
        add_link(a2, "1/1/25", fs1, "Eth1/2", "10G")

        # Aruba ACC-3 uplink → FS TOR-2 (port 1)
        add_link(a3, "1/1/49", fs2, "Eth1/1", "10G")

        # AP eth0 uplink → rotating Aruba access port
        uplink_sw = [a1, a2, a3][ri % 3]
        add_link(d["ap"], "eth0", uplink_sw, "1/1/3", "2.5G")

    # Inter-rack ring: FS TOR-2 port 22 → next rack FS TOR-1 port 22
    for i, rack in enumerate(RACKS):
        next_rack = RACKS[(i + 1) % len(RACKS)]
        local_fs2  = devices_by_rack[rack["id"]]["fs2"]
        remote_fs1 = devices_by_rack[next_rack["id"]]["fs1"]
        add_link(local_fs2, "HundredGigE1/2", remote_fs1, "HundredGigE1/2", "100G")

    db.commit()
    print(f"  [OK] {links_added} link entries added")

    # ── 3. VLAN names, trunk VLANs and spanning tree ─────────────────────────
    print("Applying VLAN names, trunk VLANs and spanning tree state …")
    apply_vlan_stp_overlay(db, devices_by_rack)
    db.commit()
    print("  [OK] Root bridge: " + devices_by_rack[RACKS[0]["id"]]["fs1"].sys_name)

    # ── 4. Demo enrichment ───────────────────────────────────────────────────
    all_devices = [devices_by_rack[rack["id"]][key] for rack in RACKS
                   for key in ("fs1", "fs2", "aruba1", "aruba2", "aruba3", "ap")]

    print("Creating switch models and enriching devices …")
    models_by_name = create_switch_models(db)
    add_ap_wireless_ports(db, devices_by_rack)
    db.flush()
    enrich_devices(db, all_devices, models_by_name, now)
    db.commit()
    print(f"  [OK] {len(models_by_name)} switch models; offline: "
          + ", ".join(d.sys_name for d in all_devices if d.ping_status == "offline"))

    print("Creating endpoints …")
    ep_counts = seed_endpoints(db, devices_by_rack, now)
    db.commit()
    print(f"  [OK] {ep_counts['endpoints']} endpoints, {ep_counts['associations']} port associations "
          f"({ep_counts['history']} historical, {ep_counts['inactive']} inactive endpoints)")

    print("Writing app settings and demo users …")
    upsert_settings(db, DEMO_SETTINGS)
    users = seed_users(db)
    db.commit()
    print(f"  [OK] Settings: {', '.join(sorted(DEMO_SETTINGS))}")
    print(f"  [OK] Demo users: {', '.join(name for name, _, _ in DEMO_USERS)} (password '{DEMO_PASSWORD}')")

    print("Creating scan history …")
    cred_by_ip = {c.ip: c for c in db.query(Credential).all()}
    runs = seed_scan_runs(db, all_devices, cred_by_ip, now,
                          {"fs": prof_fs.id, "aruba_cx": prof_aruba.id})
    db.commit()
    print(f"  [OK] {len(runs)} scan runs (latest {SCAN_SCHEDULE[0][0]} min ago)")

    print("Creating audit trail …")
    audit_count = seed_audit_logs(db, now, users, {
        "racks": [managed_racks[rack["id"]] for rack in RACKS],
        "profiles": [prof_fs, prof_aruba],
        "classes": [cls_tor, cls_acc, cls_ap],
        "models": list(models_by_name.values()),
        "devices": {d.sys_name: d for d in all_devices},
        "credentials": cred_by_ip,
        "runs": runs,
    })
    db.commit()
    print(f"  [OK] {audit_count} audit log entries")

    print("Creating latency history (24 h per minute, 7 d every 15 min) …")
    latency_rows = seed_latency_history(db, all_devices, now)
    db.commit()
    print(f"  [OK] {latency_rows} latency_samples rows")

    # ── Summary ──────────────────────────────────────────────────────────────
    total_dev     = db.query(Device).count()
    total_port    = db.query(Port).count()
    total_link    = db.query(TopologyLink).count()
    total_cred    = db.query(Credential).count()
    total_profiles = db.query(SnmpProfile).count()
    total_racks   = db.query(RackModel).count()
    total_cls     = db.query(SwitchClass).count()

    # ASCII only: box-drawing characters crash on Windows cp1252 consoles.
    print(f"\n{'-'*52}")
    print(f"  SNMP Profiles  : {total_profiles:>4}  (2 global profiles)")
    print(f"  Managed Racks  : {total_racks:>4}  (Rack A-E)")
    print(f"  Switch Classes : {total_cls:>4}  (TOR, Access, Aggregation, Core, AP)")
    print(f"  Switch Models  : {db.query(SwitchModel).count():>4}")
    print(f"  Devices        : {total_dev:>4}  (10 FS TOR + 15 Aruba CX + 5 UniFi AP)")
    print(f"  Ports          : {total_port:>4}")
    print(f"  LLDP links     : {total_link:>4}")
    print(f"  Credentials    : {total_cred:>4}  (SNMPv3 switches, SNMPv2c APs)")
    print(f"  Endpoints      : {db.query(Endpoint).count():>4}")
    print(f"  Associations   : {db.query(EndpointPortAssociation).count():>4}")
    print(f"  Scan runs      : {db.query(ScanRun).count():>4}  "
          f"({db.query(ScanRunSwitchMetric).count()} switch metrics, "
          f"{db.query(DryRunResult).count()} dry run)")
    print(f"  Audit logs     : {db.query(AuditLog).count():>4}")
    print(f"  Latency rows   : {db.query(LatencySample).count():>6}")
    print(f"{'-'*52}")
    print("  Seed complete")

    # Invalidate the topology cache: the /api/topology ETag is derived from the
    # version counter only, so direct DB writes stay invisible to clients (304)
    # until the version changes. The scan engine does this via
    # _bump_topo_version(); the seed must do the same.
    try:
        from shared.redis_client import get_redis
        r = get_redis()
        if r:
            r.incr("net2map:topo_version")
            print("  [OK] Topology cache invalidated (topo_version bumped)")
            write_log_buffer(r, build_log_entries(runs, now))
        else:
            print("  [NOTE] No Redis configured; restart the backend to invalidate the topology cache")
    except Exception as exc:
        print(f"  [NOTE] Could not write Redis demo data: {exc}")

    try:
        published = seed_latency_state(all_devices)
        if published:
            print(f"  [OK] Latency state published for {published} devices (heartbeat, baselines)")
        else:
            print("  [NOTE] Latency monitor lock is held (simulator running); it publishes the live state")
    except Exception as exc:
        print(f"  [NOTE] Could not publish latency state: {exc}")


# ─── Latency simulator (python seed_db.py --simulate-latency) ────────────────

class SimulatedLatencyMonitor(LatencyMonitor):
    """LatencyMonitor whose probe returns simulated samples instead of ICMP.

    Everything else (lock, rolling windows, rollups, baselines, purge, Redis
    publishing) is the real monitor code. Rollups of the current minute are
    flushed every round (merged by device and minute), so the history charts
    move without waiting for the minute to complete.
    """

    def __init__(self, **kwargs):
        super().__init__(probe_fn=self._simulated_probe, **kwargs)
        self.profiles: dict[int, tuple[str, float, float]] = {}
        self.sim_rng = random.Random(4711)

    def _load_config(self):
        settings, targets = super()._load_config()
        if targets:
            db = self.session()
            try:
                rows = (
                    db.query(Device.id, Device.sys_name, Device.vendor)
                    .filter(Device.id.in_([device_id for device_id, _ in targets]))
                    .all()
                )
            finally:
                db.close()
            self.profiles = {
                row.id: (row.sys_name or "", *latency_profile(row.sys_name or "", row.vendor or ""))
                for row in rows
            }
        return settings, targets

    async def _simulated_probe(self, device_id: int, ip: str, count: int, timeout_sec: int) -> Sample:
        name, base, jitter = self.profiles.get(device_id) or (ip, *latency_profile(ip, ""))
        return simulate_sample(device_id, name, base, jitter, self.now_fn(), 0.0, count, self.sim_rng)

    async def flush(self, now: datetime, include_current: bool = False) -> int:
        return await super().flush(now, include_current=True)


async def _simulate_latency_forever() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, AttributeError, ValueError):
            loop.add_signal_handler(sig, stop.set)
    # An empty or not yet seeded database simply yields no targets; the loop
    # keeps polling every interval until devices appear.
    await SimulatedLatencyMonitor().run_forever(stop)


def run_latency_simulator() -> None:
    from config import settings as app_settings

    logging.basicConfig(
        level=getattr(logging, app_settings.log_level.upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("seed_db").info("demo latency simulator started (no ICMP probes)")
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(_simulate_latency_forever())


def seed_latency_state(devices: list[Device]) -> int:
    """Run one simulated monitor round with pre-filled windows.

    Publishes per-device state, heartbeat and baselines to Redis and writes
    the current-minute rollups. Returns the number of devices with state (0
    when another monitor instance holds the lock).
    """
    mon = SimulatedLatencyMonitor()
    now = mon.now_fn()
    for dev in devices:
        base, jitter = latency_profile(dev.sys_name, dev.vendor)
        mon.windows[dev.id] = deque(
            (simulate_sample(dev.id, dev.sys_name, base, jitter,
                             now - timedelta(seconds=10 * (WINDOW_SIZE - i)), 0.0, DEFAULT_PINGS, mon.sim_rng)
             for i in range(WINDOW_SIZE - 1)),
            maxlen=WINDOW_SIZE,
        )
    try:
        asyncio.run(mon.run_round())
    finally:
        mon.release_lock()
    return len(mon.state)


# ─── Entry point ──────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Net2Map demo seed data (development only).")
    parser.add_argument(
        "--simulate-latency", action="store_true",
        help="run a latency monitor simulator for the seeded devices until SIGTERM/SIGINT",
    )
    args = parser.parse_args(argv)
    if args.simulate_latency:
        run_latency_simulator()
        return

    print("Creating tables …")
    create_tables()
    db = Session(engine)
    try:
        seed(db)
    except Exception as e:
        db.rollback()
        print(f"ERROR: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
