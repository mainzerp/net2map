# DEVELOPMENT SEED DATA ONLY -- do not run against production databases.
"""
Seed script – populates the NetMap database with realistic dummy data.

Topology
────────
  5 Racks (Rack-A … Rack-E) across 3 server rooms
  Each rack:
    • 2× FS.com S5860-20SQ   (Top-of-Rack, vendor = "fs")
    • 3× Aruba CX switches   (Access, vendor = "aruba_cx")
        – 2× Aruba CX 6300M connected to FS TOR-1
        – 1× Aruba CX 6200F  connected to FS TOR-2

Links (stored as TopologyLink / LLDP)
    • Within rack  : FS TOR-1 ↔ FS TOR-2  (100G inter-switch trunk)
    • Within rack  : Aruba-1/2 → FS TOR-1  (10G uplink)
    • Within rack  : Aruba-3   → FS TOR-2  (10G uplink)
    • Inter-rack   : ring A→B→C→D→E→A via FS TOR-2 100G uplink ports

Credentials
    • One SNMPv3 credential per FS TOR switch   (authPriv / SHA-256 / AES-128)
    • One SNMPv3 credential per Aruba CX switch (authPriv / SHA-256 / AES-256)
"""
import random
import sys
import os

# ── Make sure we can import the app's own modules ────────────────────────────
sys.path.insert(0, os.path.dirname(__file__))

from database import (
    Base, Credential, Device, Endpoint, EndpointPortAssociation,
    Port, TopologyLink, SnmpProfile,
    SwitchClass, Rack as RackModel, create_tables,
)
from sqlalchemy.orm import Session
from database import engine

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

# (cx, cy) for each rack cluster in the 900×550 SVG canvas
RACK_CENTERS = [
    (160, 155),   # Rack A
    (460, 105),   # Rack B
    (760, 220),   # Rack C
    (690, 440),   # Rack D
    (195, 425),   # Rack E
]

# Offsets within a cluster (fs1, fs2, aruba1, aruba2, aruba3)
CLUSTER_OFFSETS = [
    (-40, -50),   # FS TOR-1
    ( 40, -50),   # FS TOR-2
    (-70,  45),   # Aruba CX-1  → TOR-1
    (  0,  45),   # Aruba CX-2  → TOR-1
    ( 70,  45),   # Aruba CX-3  → TOR-2
]

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


# ─── Main seed routine ────────────────────────────────────────────────────────

def seed(db: Session):
    print("Clearing existing data ...")
    db.query(TopologyLink).delete()
    db.query(Port).delete()
    db.query(Device).delete()
    db.query(Credential).delete()
    db.query(SnmpProfile).delete()
    db.query(SwitchClass).delete()
    db.query(RackModel).delete()
    db.commit()

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
    for sc in [cls_tor, cls_acc, cls_agg, cls_cor]:
        db.add(sc)
    db.flush()
    print(f"  [OK] Classes: {cls_tor.label}, {cls_acc.label}, {cls_agg.label}, {cls_cor.label}")

    # ── 0c. Managed Racks ───────────────────────────────────────────────────
    print("Creating managed racks …")
    managed_racks: dict[str, RackModel] = {}
    for rack in RACKS:
        mr = RackModel(label=rack["label"], room=rack["room"])
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
            class_id  = cls_tor.id,
            label     = f"{rack['label']} TOR-1 -- {FS_MODEL}",
            enabled   = True,
        )
        db.add(fs1); db.flush()
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
            class_id  = cls_tor.id,
            label     = f"{rack['label']} TOR-2 -- {FS_MODEL}",
            enabled   = True,
        )
        db.add(fs2); db.flush()
        for p in make_fs_ports(fs2.id, ri, 1):
            db.add(p)

        # ── Aruba CX-1  (6300M → TOR-1) ──────────────────────────────────
        ox, oy = CLUSTER_OFFSETS[2]
        aruba1 = Device(
            sys_name  = f"aruba-{rack_id}-acc1",
            ip        = make_ip(2),
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
        db.add(aruba1); db.flush()
        for p in make_aruba_6300_ports(aruba1.id, ri, 2):
            db.add(p)

        # ── Aruba CX-2  (6300M → TOR-1) ──────────────────────────────────
        ox, oy = CLUSTER_OFFSETS[3]
        aruba2 = Device(
            sys_name  = f"aruba-{rack_id}-acc2",
            ip        = make_ip(3),
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
        db.add(aruba2); db.flush()
        for p in make_aruba_6300_ports(aruba2.id, ri, 3):
            db.add(p)

        # ── Aruba CX-3  (6200F → TOR-2) ──────────────────────────────────
        ox, oy = CLUSTER_OFFSETS[4]
        aruba3 = Device(
            sys_name  = f"aruba-{rack_id}-acc3",
            ip        = make_ip(4),
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
        db.add(aruba3); db.flush()
        for p in make_aruba_6200_ports(aruba3.id, ri, 4):
            db.add(p)

        devices_by_rack[rack_id] = {
            "fs1": fs1, "fs2": fs2,
            "aruba1": aruba1, "aruba2": aruba2, "aruba3": aruba3,
        }

        # ── Credentials ─────────────────────────────────────────────────────
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

    for rack in RACKS:
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

    # Inter-rack ring: FS TOR-2 port 22 → next rack FS TOR-1 port 22
    for i, rack in enumerate(RACKS):
        next_rack = RACKS[(i + 1) % len(RACKS)]
        local_fs2  = devices_by_rack[rack["id"]]["fs2"]
        remote_fs1 = devices_by_rack[next_rack["id"]]["fs1"]
        add_link(local_fs2, "HundredGigE1/2", remote_fs1, "HundredGigE1/2", "100G")

    db.commit()
    print(f"  [OK] {links_added} link entries added")

    # ── Summary ──────────────────────────────────────────────────────────────
    total_dev     = db.query(Device).count()
    total_port    = db.query(Port).count()
    total_link    = db.query(TopologyLink).count()
    total_cred    = db.query(Credential).count()
    total_profiles = db.query(SnmpProfile).count()
    total_racks   = db.query(RackModel).count()
    total_cls     = db.query(SwitchClass).count()

    print(f"\n{'─'*52}")
    print(f"  SNMP Profiles  : {total_profiles:>4}  (2 global profiles)")
    print(f"  Managed Racks  : {total_racks:>4}  (Rack A-E)")
    print(f"  Switch Classes : {total_cls:>4}  (TOR, Access, Aggregation, Core)")
    print(f"  Devices        : {total_dev:>4}  (10 FS TOR + 15 Aruba CX)")
    print(f"  Ports          : {total_port:>4}")
    print(f"  LLDP links     : {total_link:>4}")
    print(f"  Credentials    : {total_cred:>4}  (SNMPv3 authPriv)")
    print(f"{'─'*52}")
    print("  Seed complete")


# ─── Entry point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
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
