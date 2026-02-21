"""SQLAlchemy database setup and models."""
import os
from datetime import datetime
from sqlalchemy import (
    create_engine, Column, Integer, String, Boolean,
    DateTime, Float, ForeignKey, Text, text,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./netmap.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─── Models ───────────────────────────────────────────────────────────────────

class Rack(Base):
    """Manually defined rack / enclosure in the data center."""
    __tablename__ = "racks"

    id          = Column(Integer, primary_key=True, index=True)
    label       = Column(String, nullable=False)          # e.g. "Rack A"
    room        = Column(String, default="")              # e.g. "RZ-01"
    description = Column(String, default="")
    created_at  = Column(DateTime, default=datetime.utcnow)
    updated_at  = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    devices = relationship("Device", back_populates="rack")


class SwitchClass(Base):
    """Logical role / class assignable to a device (e.g. Top of Rack, Aggregation)."""
    __tablename__ = "switch_classes"

    id          = Column(Integer, primary_key=True, index=True)
    label       = Column(String, nullable=False)          # e.g. "Top of Rack"
    description = Column(String, default="")
    color       = Column(String, default="#64748b")       # hex color for UI highlights
    created_at  = Column(DateTime, default=datetime.utcnow)
    updated_at  = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    devices = relationship("Device", back_populates="switch_class")


class SnmpProfile(Base):
    """Reusable SNMP credential profile assignable to multiple switches."""
    __tablename__ = "snmp_profiles"

    id                 = Column(Integer, primary_key=True, index=True)
    label              = Column(String, nullable=False)
    snmp_version       = Column(String, default="v2c")       # "v2c" | "v3"
    community          = Column(String, default="public")
    v3_security_level  = Column(String, default="authPriv")
    v3_username        = Column(String, default="")
    v3_auth_protocol   = Column(String, default="SHA-256")
    v3_auth_password   = Column(String, default="")
    v3_priv_protocol   = Column(String, default="AES-128")
    v3_priv_password   = Column(String, default="")
    snmp_timeout       = Column(Integer, default=3)          # seconds per request
    snmp_retries       = Column(Integer, default=1)          # retry count per request
    max_parallel_hosts = Column(Integer, default=8)          # per-profile host concurrency
    created_at         = Column(DateTime, default=datetime.utcnow)
    updated_at         = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    credentials = relationship("Credential", back_populates="profile")


class Credential(Base):
    """Switch access credential – supports SNMPv2c and SNMPv3."""
    __tablename__ = "credentials"

    id          = Column(Integer, primary_key=True, index=True)
    label       = Column(String, nullable=False)          # friendly name
    ip          = Column(String, nullable=False, unique=True)
    snmp_port   = Column(Integer, default=161)
    location    = Column(String, default="")              # e.g. rack label / room
    enabled     = Column(Boolean, default=True)
    created_at  = Column(DateTime, default=datetime.utcnow)
    updated_at  = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # ── SNMPv2c ──────────────────────────────────────────────────────────────
    snmp_version = Column(String, default="v2c")          # "v2c" | "v3"
    community    = Column(String, default="public")       # v2c only

    # ── SNMPv3 ───────────────────────────────────────────────────────────────
    # security_level: "noAuthNoPriv" | "authNoPriv" | "authPriv"
    v3_security_level  = Column(String, default="authPriv")
    v3_username        = Column(String, default="")
    # auth: "MD5" | "SHA" | "SHA-224" | "SHA-256" | "SHA-384" | "SHA-512"
    v3_auth_protocol   = Column(String, default="SHA-256")
    v3_auth_password   = Column(String, default="")
    # priv: "DES" | "3DES" | "AES-128" | "AES-192" | "AES-256"
    v3_priv_protocol   = Column(String, default="AES-128")
    v3_priv_password   = Column(String, default="")

    # Optional reference to a shared profile (overrides per-device SNMP fields when set)
    profile_id = Column(Integer, ForeignKey("snmp_profiles.id"), nullable=True)
    profile    = relationship("SnmpProfile", back_populates="credentials")


class Device(Base):
    """Discovered switch / router node."""
    __tablename__ = "devices"

    id           = Column(Integer, primary_key=True, index=True)
    sys_name     = Column(String, index=True)             # SNMP sysName
    ip           = Column(String, nullable=False, unique=True, index=True)
    sys_descr    = Column(Text, default="")
    model        = Column(String, default="")
    vendor       = Column(String, default="")             # "aruba_cx" | "fs" | "generic"
    location     = Column(String, default="")             # sysLocation
    map_x        = Column(Float, default=100.0)
    map_y        = Column(Float, default=100.0)
    last_seen    = Column(DateTime, default=datetime.utcnow)

    # Optional assignment to a managed rack and switch class
    rack_id      = Column(Integer, ForeignKey("racks.id"), nullable=True)
    class_id     = Column(Integer, ForeignKey("switch_classes.id"), nullable=True)

    ports        = relationship("Port", back_populates="device", cascade="all, delete-orphan")
    rack         = relationship("Rack", back_populates="devices")
    switch_class = relationship("SwitchClass", back_populates="devices")


class Port(Base):
    """Network interface / port on a device."""
    __tablename__ = "ports"

    id           = Column(Integer, primary_key=True, index=True)
    device_id    = Column(Integer, ForeignKey("devices.id"), nullable=False, index=True)
    if_index     = Column(Integer, nullable=False)
    if_descr     = Column(String, default="")
    if_alias     = Column(String, default="")
    speed_mbps   = Column(Integer, default=0)
    oper_status  = Column(Integer, default=2)             # 1=up, 2=down
    # connected end-device info (from ARP / MAC table)
    peer_mac     = Column(String, default="")
    peer_ip      = Column(String, default="")
    peer_host    = Column(String, default="")
    vlan         = Column(Integer, default=0)

    device = relationship("Device", back_populates="ports")


class TopologyLink(Base):
    """Switch-to-switch link discovered via LLDP."""
    __tablename__ = "topology_links"

    id             = Column(Integer, primary_key=True, index=True)
    local_ip       = Column(String, nullable=False)
    local_port     = Column(String, default="")
    remote_ip      = Column(String, default="")
    remote_sys     = Column(String, default="")
    remote_port    = Column(String, default="")
    speed_label    = Column(String, default="1G")         # "1G" | "10G" | "100G"
    discovered_at  = Column(DateTime, default=datetime.utcnow)


class ScanRun(Base):
    """Historical summary for one scan execution."""
    __tablename__ = "scan_runs"

    id                = Column(Integer, primary_key=True, index=True)
    status            = Column(String, default="finished")          # finished|cancelled|failed
    scanned           = Column(Integer, default=0)
    found             = Column(Integer, default=0)
    links             = Column(Integer, default=0)
    max_workers       = Column(Integer, default=1)
    total_duration_ms = Column(Integer, default=0)
    error_count       = Column(Integer, default=0)
    created_at        = Column(DateTime, default=datetime.utcnow)

    switch_metrics = relationship(
        "ScanRunSwitchMetric",
        back_populates="scan_run",
        cascade="all, delete-orphan",
    )


class ScanRunSwitchMetric(Base):
    """Historical per-switch metrics belonging to a scan run."""
    __tablename__ = "scan_run_switch_metrics"

    id           = Column(Integer, primary_key=True, index=True)
    scan_run_id  = Column(Integer, ForeignKey("scan_runs.id"), nullable=False, index=True)
    ip           = Column(String, default="")
    label        = Column(String, default="")
    duration_ms  = Column(Integer, default=0)
    success      = Column(Boolean, default=False)
    error        = Column(Text, default="")

    scan_run = relationship("ScanRun", back_populates="switch_metrics")


def _ensure_snmp_profile_policy_columns():
    """Add new scan policy columns for existing SQLite databases without migrations."""
    with engine.begin() as conn:
        if conn.dialect.name != "sqlite":
            return

        rows = conn.execute(text("PRAGMA table_info(snmp_profiles)")).fetchall()
        existing = {str(r[1]) for r in rows}

        additions = [
            ("snmp_timeout", "INTEGER DEFAULT 3"),
            ("snmp_retries", "INTEGER DEFAULT 1"),
            ("max_parallel_hosts", "INTEGER DEFAULT 8"),
        ]
        for col_name, col_def in additions:
            if col_name not in existing:
                conn.execute(text(f"ALTER TABLE snmp_profiles ADD COLUMN {col_name} {col_def}"))


def create_tables():
    Base.metadata.create_all(bind=engine)
    _ensure_snmp_profile_policy_columns()
