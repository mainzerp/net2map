"""SQLAlchemy database setup and models."""
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

from config import settings
from latency.settings import SETTING_DEFAULTS as LATENCY_SETTING_DEFAULTS

DATABASE_URL = settings.database_url

_engine_kwargs = {}
if DATABASE_URL.startswith("postgresql"):
    _engine_kwargs.update(
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,
        pool_recycle=300,
    )
elif DATABASE_URL.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **_engine_kwargs)

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
    map_x       = Column(Float, default=100.0)
    map_y       = Column(Float, default=100.0)
    height_u    = Column(Integer, nullable=False, server_default="42")  # usable rack units
    created_at  = Column(DateTime, server_default=func.now())
    updated_at  = Column(DateTime, server_default=func.now(), onupdate=func.now())

    devices = relationship("Device", back_populates="rack")
    items   = relationship("RackItem", back_populates="rack", cascade="all, delete-orphan")


class RackItem(Base):
    """Manually maintained placeholder in a rack elevation (patch panel, blank, ...).

    Never scanned and without ports or cabling: it only occupies U space.
    """
    __tablename__ = "rack_items"

    id              = Column(Integer, primary_key=True, index=True)
    rack_id         = Column(Integer, ForeignKey("racks.id", ondelete="CASCADE"), nullable=False, index=True)
    kind            = Column(String, nullable=False, default="patch_panel", server_default="patch_panel")
    label           = Column(String, nullable=False, default="", server_default="")
    rack_u_position = Column(Integer, nullable=False)   # 1-based bottom U
    u_height        = Column(Integer, nullable=False, default=1, server_default="1")
    note            = Column(Text, nullable=True)
    created_at      = Column(DateTime, server_default=func.now())
    updated_at      = Column(DateTime, server_default=func.now(), onupdate=func.now())

    rack = relationship("Rack", back_populates="items")


class SwitchClass(Base):
    """Logical role / class assignable to a device (e.g. Top of Rack, Aggregation)."""
    __tablename__ = "switch_classes"

    id          = Column(Integer, primary_key=True, index=True)
    label       = Column(String, nullable=False)          # e.g. "Top of Rack"
    description = Column(String, default="")
    color       = Column(String, default="#64748b")       # hex color for UI highlights
    allow_outside_rack = Column(Boolean, default=False, nullable=False)
    created_at  = Column(DateTime, server_default=func.now())
    updated_at  = Column(DateTime, server_default=func.now(), onupdate=func.now())

    devices = relationship("Device", back_populates="switch_class")


class SwitchModel(Base):
    """Physical switch model definition with port layout parameters."""
    __tablename__ = "switch_models"

    id            = Column(Integer, primary_key=True, index=True)
    name          = Column(String, nullable=False, unique=True)   # e.g. "Aruba CX 6300M-48"
    ports_per_row = Column(Integer, default=24)                   # physical ports per row on faceplate
    total_ports   = Column(Integer, nullable=True)                # expected total ports (optional)
    description   = Column(String, default="")
    created_at    = Column(DateTime, server_default=func.now())
    updated_at    = Column(DateTime, server_default=func.now(), onupdate=func.now())

    devices = relationship("Device", back_populates="switch_model")


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
    created_at         = Column(DateTime, server_default=func.now())
    updated_at         = Column(DateTime, server_default=func.now(), onupdate=func.now())

    credentials = relationship("Credential", back_populates="profile")


class Credential(Base):
    """Switch access credential – supports SNMPv2c and SNMPv3."""
    __tablename__ = "credentials"
    __table_args__ = (UniqueConstraint("ip", "priority", name="uq_credential_ip_priority"),)

    id          = Column(Integer, primary_key=True, index=True)
    label       = Column(String, nullable=False)          # friendly name
    ip          = Column(String, nullable=False, index=True)
    priority    = Column(Integer, default=0)               # lower = tried first
    snmp_port   = Column(Integer, default=161)
    enabled     = Column(Boolean, default=True)
    created_at  = Column(DateTime, server_default=func.now())
    updated_at  = Column(DateTime, server_default=func.now(), onupdate=func.now())

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

    # ── SNMP engine ID (not secret, stored unencrypted as lowercase hex) ────
    # Manual override of the authoritative engine ID (v3 only); NULL means
    # automatic discovery.
    v3_engine_id         = Column(String, nullable=True)
    # Engine ID observed via snmpEngineID.0 during the last successful scan.
    discovered_engine_id = Column(String, nullable=True)
    engine_id_seen_at    = Column(DateTime, nullable=True)

    # Optional reference to a shared profile (overrides per-device SNMP fields when set)
    profile_id = Column(Integer, ForeignKey("snmp_profiles.id"), nullable=True)
    profile    = relationship("SnmpProfile", back_populates="credentials")

    # FK link to the discovered Device
    device_id  = Column(Integer, ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True)
    device     = relationship("Device", back_populates="credentials", lazy="joined")


class Device(Base):
    """Discovered switch / router node."""
    __tablename__ = "devices"

    id           = Column(Integer, primary_key=True, index=True)
    sys_name     = Column(String, index=True)             # SNMP sysName
    ip           = Column(String, nullable=False, unique=True, index=True)
    sys_descr    = Column(Text, default="")
    model        = Column(String, default="")
    firmware     = Column(String, default="", server_default="")  # entPhysicalSoftwareRev / parsed from sysDescr
    vendor       = Column(String, default="")             # "aruba_cx" | "fs" | "generic"
    # True when vendor was set manually via the topology API; the scan engine
    # then keeps it instead of overwriting it with the auto-detected vendor.
    vendor_override = Column(Boolean, default=False, nullable=False, server_default="false")
    location     = Column(String, default="")             # sysLocation
    ping_status  = Column(String, default="unknown")      # online|offline|unknown
    ping_rtt_ms  = Column(Integer, default=0)
    last_ping    = Column(DateTime, nullable=True)
    map_x        = Column(Float, default=100.0)
    map_y        = Column(Float, default=100.0)
    last_seen    = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    ignored      = Column(Boolean, default=False, nullable=False)
    # Included by the latency monitor when latency_mode is "selected".
    latency_monitored = Column(Boolean, default=False, nullable=False, server_default="false")

    # Optional assignment to a managed rack and switch class
    rack_id      = Column(Integer, ForeignKey("racks.id"), nullable=True)
    class_id     = Column(Integer, ForeignKey("switch_classes.id"), nullable=True)
    model_id     = Column(Integer, ForeignKey("switch_models.id"), nullable=True)

    # Rack elevation placement: 1-based bottom U position (null = not placed)
    # and the number of rack units the device occupies.
    rack_u_position = Column(Integer, nullable=True)
    u_height        = Column(Integer, nullable=False, server_default="1")

    # Consolidation fields (metadata now lives here, not on Credential)
    label        = Column(String, default="")
    enabled      = Column(Boolean, default=True, nullable=False)

    # Spanning tree summary (BRIDGE-MIB / RSTP-MIB default instance); NULL
    # when the device does not report it.
    stp_protocol  = Column(String(16), nullable=True)   # stp|rstp|mstp|unknown
    stp_bridge_id = Column(String(32), nullable=True)   # "<prio hex4>.<mac hex12>"
    stp_root_id   = Column(String(32), nullable=True)
    stp_root_cost = Column(Integer, nullable=True)
    stp_root_port = Column(String(64), nullable=True)   # port name (if_descr) toward the root
    # VLAN id (string) -> name from dot1qVlanStaticName
    vlan_names    = Column(JSONB, nullable=True, default=dict, server_default="{}")
    # Interface name cache: ifIndex (string) -> [ifDescr, ifAlias], refreshed
    # by a full name walk at most every discovery interval.
    if_names      = Column(JSONB, nullable=True)
    if_names_at   = Column(DateTime, nullable=True)
    # Last collection of VLAN data (PVID, tagged VLANs, VLAN names) and of
    # spanning tree data; MAC scans re-walk them once their interval passed.
    vlan_at       = Column(DateTime, nullable=True)
    stp_at        = Column(DateTime, nullable=True)

    # Device kind derived from the detected vendor scanner during a scan:
    # "switch" | "firewall" | "ups" | "server". Editable via the meta PATCH.
    device_type   = Column(String(16), nullable=False, default="switch", server_default="switch")
    # Normalized health snapshot (see scanners.health), NULL when the device
    # reports none; health_updated_at is the collection time (naive UTC).
    health            = Column(JSONB, nullable=True)
    health_updated_at = Column(DateTime, nullable=True)

    ports        = relationship("Port", back_populates="device", cascade="all, delete-orphan", lazy="selectin")
    rack         = relationship("Rack", back_populates="devices", lazy="joined")
    switch_class = relationship("SwitchClass", back_populates="devices", lazy="joined")
    switch_model = relationship("SwitchModel", back_populates="devices", lazy="joined")
    credentials  = relationship("Credential", back_populates="device", lazy="selectin")


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
    vlan         = Column(Integer, default=0)
    tagged_vlans = Column(JSONB, default=list)
    # Spanning tree (BRIDGE-MIB default instance); NULL when not reported
    stp_state     = Column(String(16), nullable=True)   # disabled|blocking|listening|learning|forwarding|broken
    stp_role      = Column(String(16), nullable=True)   # root|designated|blocked|disabled (derived)
    stp_path_cost = Column(Integer, nullable=True)

    device = relationship("Device", back_populates="ports")
    endpoint_associations = relationship(
        "EndpointPortAssociation", back_populates="port",
        cascade="all, delete-orphan", lazy="selectin",
    )


class Endpoint(Base):
    """Discovered endpoint device (MAC/IP found on a switch port)."""
    __tablename__ = "endpoints"

    id         = Column(Integer, primary_key=True, index=True)
    mac        = Column(String, nullable=False, unique=True, index=True)
    ip         = Column(String, nullable=True, index=True)
    hostname   = Column(String, nullable=True)
    first_seen = Column(DateTime, server_default=func.now())
    last_seen  = Column(DateTime, server_default=func.now())
    ignored    = Column(Boolean, default=False, nullable=False)
    notes      = Column(Text, nullable=True)

    port_associations = relationship(
        "EndpointPortAssociation", back_populates="endpoint",
        cascade="all, delete-orphan", lazy="selectin",
    )


class EndpointPortAssociation(Base):
    """Many-to-many link between endpoints and ports."""
    __tablename__ = "endpoint_port_associations"
    __table_args__ = (
        UniqueConstraint("endpoint_id", "port_id", name="uq_epa_endpoint_port"),
    )

    id          = Column(Integer, primary_key=True, index=True)
    endpoint_id = Column(Integer, ForeignKey("endpoints.id", ondelete="CASCADE"), nullable=False, index=True)
    port_id     = Column(Integer, ForeignKey("ports.id", ondelete="CASCADE"), nullable=False, index=True)
    vlan_id     = Column(Integer, nullable=True)
    last_seen   = Column(DateTime, server_default=func.now())

    endpoint = relationship("Endpoint", back_populates="port_associations")
    port     = relationship("Port", back_populates="endpoint_associations")


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
    discovered_at  = Column(DateTime, server_default=func.now())


class AppSetting(Base):
    """Global application settings (key-value store)."""
    __tablename__ = "app_settings"

    key   = Column(String, primary_key=True, index=True)
    value = Column(String, nullable=False)


class User(Base):
    """Application user with role-based access."""
    __tablename__ = "users"

    id         = Column(Integer, primary_key=True, index=True)
    username   = Column(String, nullable=False, unique=True, index=True)
    email      = Column(String, default="")
    hashed_pw  = Column(String, nullable=False)
    role       = Column(String, default="viewer")  # "admin" | "operator" | "viewer"
    is_active  = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class AuditLog(Base):
    """Audit trail for configuration changes."""
    __tablename__ = "audit_logs"

    id          = Column(Integer, primary_key=True, index=True)
    timestamp   = Column(DateTime, server_default=func.now(), index=True)
    user_id     = Column(Integer, nullable=True)
    username    = Column(String, default="")
    action      = Column(String, nullable=False)   # "create"|"update"|"delete"|"scan"|"settings_change"
    resource    = Column(String, nullable=False)    # "credential"|"snmp_profile"|"device"|...
    resource_id = Column(String, default="")
    details     = Column(JSONB, default=dict)


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
    devices_snapshot_json = Column(JSONB, default=list)
    links_snapshot_json   = Column(JSONB, default=list)
    created_at        = Column(DateTime, server_default=func.now())

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


class DryRunResult(Base):
    """Persisted dry-run scan preview for later retrieval."""
    __tablename__ = "dry_run_results"

    id           = Column(Integer, primary_key=True, index=True)
    scan_run_id  = Column(Integer, ForeignKey("scan_runs.id", ondelete="CASCADE"), nullable=True)
    preview_json = Column(JSONB, default=list)
    created_at   = Column(DateTime, server_default=func.now())


class LeaseFence(Base):
    """Highest fencing token that committed under a distributed lease.

    Guarded transactions upsert their lease token here first; a token lower
    than the stored one belongs to a stale lease holder and is rejected.
    """
    __tablename__ = "lease_fences"

    name       = Column(String, primary_key=True)
    token      = Column(BigInteger, nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now())


class LatencySample(Base):
    """Per-minute latency rollup for one device, written by the latency monitor."""
    __tablename__ = "latency_samples"
    __table_args__ = (UniqueConstraint("device_id", "bucket_ts", name="uq_latency_samples_device_bucket"),)

    id         = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    device_id  = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    bucket_ts  = Column(DateTime(timezone=True), nullable=False, index=True)  # minute start, UTC
    rtt_avg_ms = Column(Float, nullable=True)
    rtt_min_ms = Column(Float, nullable=True)
    rtt_max_ms = Column(Float, nullable=True)
    jitter_ms  = Column(Float, nullable=True)
    loss_pct   = Column(Float, nullable=False)
    probes     = Column(Integer, nullable=False)                             # echo requests sent


def _seed_default_settings():
    """Insert default app_settings rows if they do not already exist.

    This is pure DML — no DDL. Safe to call every startup because
    INSERT OR IGNORE is a no-op when the row is already present.
    """
    with engine.begin() as conn:
        defaults = [
            ("discovery_interval_sec", "1800"),
            ("port_update_interval_sec", "30"),
            ("link_update_interval_sec", "60"),
            ("mac_update_interval_sec", "300"),
            ("vlan_update_interval_sec", "1800"),
            ("stp_update_interval_sec", "300"),
            ("discovery_scan_ranges", "[]"),
            ("scan_max_workers", "12"),
            ("scan_snmp_timeout", "3"),
            ("scan_snmp_retries", "1"),
            ("scan_snmp_bulk_size", "25"),
            ("dns_servers", "[]"),
            ("map_opacity", "0.3"),
            ("map_scale", "1.0"),
            ("map_bg_color", "#020817"),
            *LATENCY_SETTING_DEFAULTS.items(),
        ]
        for key, value in defaults:
            conn.execute(
                text(
                    "INSERT INTO app_settings (key, value) VALUES (:key, :value)"
                    " ON CONFLICT (key) DO NOTHING"
                ),
                {"key": key, "value": value},
            )


def create_tables():
    """Ensure tables exist and seed initial data.

    In Docker deployments the entrypoint runs `alembic upgrade head` before
    uvicorn starts, so by the time this function is called all tables already
    exist and create_all() is a no-op.

    In bare-Python local dev (no Docker, no alembic run) create_all() creates
    the tables from the ORM metadata so the app can start without any migration
    tooling.
    """
    Base.metadata.create_all(bind=engine)
    _seed_default_settings()
