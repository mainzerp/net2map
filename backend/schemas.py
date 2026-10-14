"""Pydantic schemas for request / response validation."""
import re
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_serializer,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticUndefined

# ─── Structured Error Response ────────────────────────────────────────────────

class ErrorDetail(BaseModel):
    code: str
    message: str
    field: Optional[str] = None
    details: Optional[List[dict]] = None

class APIError(BaseModel):
    error: ErrorDetail


# ─── Auth & Users ─────────────────────────────────────────────────────────────

UserRole = Literal["admin", "operator", "viewer"]

# bcrypt only uses the first 72 bytes of a password and newer bcrypt releases
# reject longer input; new passwords must fit.
PASSWORD_MAX_BYTES = 72
# Login input bound: longer values are rejected with 422 before hashing work.
# Values between PASSWORD_MAX_BYTES and this bound fail like a wrong password.
LOGIN_FIELD_MAX_LENGTH = 1024


def _validate_new_password(v: str) -> str:
    if len(v) < 8:
        raise ValueError("Password must be at least 8 characters long")
    if len(v.encode()) > PASSWORD_MAX_BYTES:
        raise ValueError(f"Password must not exceed {PASSWORD_MAX_BYTES} bytes")
    return v


class LoginRequest(BaseModel):
    username: str = Field(..., max_length=LOGIN_FIELD_MAX_LENGTH)
    password: str = Field(..., max_length=LOGIN_FIELD_MAX_LENGTH)

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    username: str

class UserCreate(BaseModel):
    username: str
    email: str = ""
    password: str
    role: UserRole = "viewer"

    @field_validator("password")
    @classmethod
    def validate_password(cls, v):
        return _validate_new_password(v)

class UserUpdate(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None

    @field_validator("password")
    @classmethod
    def validate_password(cls, v):
        return v if v is None else _validate_new_password(v)

class UserOut(BaseModel):
    id: int
    username: str
    email: str
    role: str
    is_active: bool
    created_at: Optional[datetime] = None
    class Config:
        from_attributes = True


# ─── Audit Log ────────────────────────────────────────────────────────────────

class AuditLogOut(BaseModel):
    id: int
    timestamp: datetime
    username: str
    action: str
    resource: str
    resource_id: str
    details: Optional[dict] = None
    class Config:
        from_attributes = True


# ─── Secret masking ───────────────────────────────────────────────────────────
# API responses mask secrets with "***"; config/bulk exports use "********".
# Both sentinels must be treated as "unchanged" by update paths and must never
# be encrypted or stored as real values.
MASK_API = "***"
MASK_EXPORT = "********"
MASK_SENTINELS = frozenset({MASK_API, MASK_EXPORT})

# ─── Enums ────────────────────────────────────────────────────────────────────
SnmpVersion   = Literal["v2c", "v3"]
SecurityLevel = Literal["noAuthNoPriv", "authNoPriv", "authPriv"]
AuthProtocol  = Literal["MD5", "SHA", "SHA-224", "SHA-256", "SHA-384", "SHA-512"]
PrivProtocol  = Literal["DES", "3DES", "AES-128", "AES-192", "AES-256"]


class AppSettingBase(BaseModel):
    key:   str
    value: str

class AppSettingUpdate(BaseModel):
    value: str

class AppSettingOut(AppSettingBase):
    class Config:
        from_attributes = True

# ─── Rack ─────────────────────────────────────────────────────────────────────

class RackBase(BaseModel):
    label:       str
    room:        str = ""
    description: str = ""
    map_x:       float = 100.0
    map_y:       float = 100.0
    height_u:    int = Field(42, ge=6, le=60)
    floor_id:    Optional[int] = None


class RackCreate(RackBase):
    pass


class RackUpdate(BaseModel):
    label:       Optional[str] = None
    room:        Optional[str] = None
    description: Optional[str] = None
    map_x:       Optional[float] = None
    map_y:       Optional[float] = None
    height_u:    Optional[int] = Field(None, ge=6, le=60)
    # Explicit null removes the rack from its floor
    floor_id:    Optional[int] = None


class RackOut(RackBase):
    id:         int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


RackSide = Literal["front", "rear"]


class RackLayoutEntry(BaseModel):
    """Placement of one device in the rack elevation (1-based U space).

    rack_side / full_depth are optional; omitted values keep the device's
    stored side and depth.
    """
    device_id:       int
    rack_u_position: int = Field(..., ge=1, le=48)
    u_height:        int = Field(..., ge=1, le=60)
    rack_side:       Optional[RackSide] = None
    full_depth:      Optional[bool] = None


class RackLayoutIn(BaseModel):
    entries: List[RackLayoutEntry]


RackItemKind = Literal["patch_panel", "blank", "cable_manager", "shelf", "other"]


class RackItemCreate(BaseModel):
    """Manually maintained rack placeholder (no ports, never scanned)."""
    kind:            RackItemKind = "patch_panel"
    label:           str = Field("", max_length=120)
    rack_u_position: int = Field(..., ge=1, le=48)
    u_height:        int = Field(1, ge=1, le=60)
    rack_side:       RackSide = "front"
    full_depth:      bool = False
    note:            Optional[str] = Field(None, max_length=2000)


class RackItemUpdate(BaseModel):
    kind:            Optional[RackItemKind] = None
    label:           Optional[str] = Field(None, max_length=120)
    rack_u_position: Optional[int] = Field(None, ge=1, le=48)
    u_height:        Optional[int] = Field(None, ge=1, le=60)
    rack_side:       Optional[RackSide] = None
    full_depth:      Optional[bool] = None
    note:            Optional[str] = Field(None, max_length=2000)


class RackItemOut(BaseModel):
    id:              int
    rack_id:         int
    kind:            str
    label:           str
    rack_u_position: int
    u_height:        int
    rack_side:       str = "front"
    full_depth:      bool = False
    note:            Optional[str] = None
    created_at:      Optional[datetime] = None
    updated_at:      Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


# ─── Buildings and floors ─────────────────────────────────────────────────────

class FloorCreate(BaseModel):
    label:      str = Field(..., min_length=1, max_length=120)
    sort_order: int = 0


class FloorUpdate(BaseModel):
    label:       Optional[str] = Field(None, min_length=1, max_length=120)
    sort_order:  Optional[int] = None
    building_id: Optional[int] = None
    bg_opacity:  Optional[float] = Field(None, ge=0.0, le=1.0)
    bg_scale:    Optional[float] = Field(None, ge=0.1, le=10.0)
    bg_color:    Optional[str] = Field(None, max_length=20)


class FloorOut(BaseModel):
    id:             int
    building_id:    int
    label:          str
    sort_order:     int = 0
    has_background: bool = False
    bg_version:     int = 0
    bg_opacity:     float = 0.3
    bg_scale:       float = 1.0
    bg_color:       str = "#020817"

    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="before")
    @classmethod
    def _derive_has_background(cls, data):
        # ORM rows carry bg_ext; the API only exposes whether a file is set.
        if not isinstance(data, dict) and hasattr(data, "bg_ext"):
            return {
                "id": data.id,
                "building_id": data.building_id,
                "label": data.label,
                "sort_order": data.sort_order or 0,
                "has_background": data.bg_ext is not None,
                "bg_version": data.bg_version or 0,
                "bg_opacity": 0.3 if data.bg_opacity is None else data.bg_opacity,
                "bg_scale": 1.0 if data.bg_scale is None else data.bg_scale,
                "bg_color": data.bg_color or "#020817",
            }
        return data


class BuildingCreate(BaseModel):
    label:       str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = None
    sort_order:  int = 0


class BuildingUpdate(BaseModel):
    label:       Optional[str] = Field(None, min_length=1, max_length=120)
    description: Optional[str] = None
    sort_order:  Optional[int] = None


class BuildingOut(BaseModel):
    id:          int
    label:       str
    description: Optional[str] = None
    sort_order:  int = 0
    floors:      List[FloorOut] = []

    model_config = ConfigDict(from_attributes=True)

    @field_validator("floors", mode="after")
    @classmethod
    def _sort_floors(cls, v):
        return sorted(v, key=lambda f: (f.sort_order, f.id))


# ─── SwitchClass ──────────────────────────────────────────────────────────────

class SwitchClassBase(BaseModel):
    label:       str
    description: str = ""
    color:       str = "#64748b"
    allow_outside_rack: bool = False


class SwitchClassCreate(SwitchClassBase):
    pass


class SwitchClassUpdate(BaseModel):
    label:       Optional[str] = None
    description: Optional[str] = None
    color:       Optional[str] = None
    allow_outside_rack: Optional[bool] = None


class SwitchClassOut(SwitchClassBase):
    id:         int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ─── SwitchModel ──────────────────────────────────────────────────────────────

class SwitchModelBase(BaseModel):
    name:          str
    ports_per_row: int = 24
    total_ports:   Optional[int] = None
    description:   str = ""


class SwitchModelCreate(SwitchModelBase):
    pass


class SwitchModelUpdate(BaseModel):
    name:          Optional[str] = None
    ports_per_row: Optional[int] = None
    total_ports:   Optional[int] = None
    description:   Optional[str] = None


class SwitchModelOut(SwitchModelBase):
    id:         int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ─── SnmpProfile ─────────────────────────────────────────────────────────────

class SnmpProfileBase(BaseModel):
    label:             str
    snmp_version:      SnmpVersion   = "v2c"
    community:         str           = "public"
    v3_security_level: SecurityLevel = "authPriv"
    v3_username:       str           = ""
    v3_auth_protocol:  AuthProtocol  = "SHA-256"
    v3_auth_password:  str           = ""
    v3_priv_protocol:  PrivProtocol  = "AES-128"
    v3_priv_password:  str           = ""


class SnmpProfileCreate(SnmpProfileBase):
    pass


class SnmpProfileUpdate(BaseModel):
    label:             Optional[str]           = None
    snmp_version:      Optional[SnmpVersion]   = None
    community:         Optional[str]           = None
    v3_security_level: Optional[SecurityLevel] = None
    v3_username:       Optional[str]           = None
    v3_auth_protocol:  Optional[AuthProtocol]  = None
    v3_auth_password:  Optional[str]           = None
    v3_priv_protocol:  Optional[PrivProtocol]  = None
    v3_priv_password:  Optional[str]           = None


class SnmpProfileOut(SnmpProfileBase):
    id:         int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @field_serializer("v3_auth_password", "v3_priv_password")
    def _mask_password(self, v: str) -> str:
        return MASK_API if v else ""

    @field_serializer("community")
    def _mask_community(self, v: str) -> str:
        return MASK_API if v else ""

    class Config:
        from_attributes = True


# ─── Credential ───────────────────────────────────────────────────────────────

# RFC 3411 SnmpEngineID: OCTET STRING (SIZE(5..32)).
ENGINE_ID_MIN_OCTETS = 5
ENGINE_ID_MAX_OCTETS = 32
_ENGINE_ID_SEPARATORS = re.compile(r"[\s:]")
_HEX_RE = re.compile(r"^[0-9a-f]*$")


def normalize_engine_id(value: Optional[str]) -> Optional[str]:
    """Normalize a user-supplied SNMP engine ID to lowercase hex.

    Accepts an optional "0x" prefix and ":" or whitespace separators.
    Empty input yields None (= automatic discovery). Raises ValueError for
    non-hex input, odd length or a size outside 5-32 octets.
    """
    if value is None:
        return None
    v = _ENGINE_ID_SEPARATORS.sub("", str(value)).lower()
    if v.startswith("0x"):
        v = v[2:]
    if not v:
        return None
    if not _HEX_RE.match(v):
        raise ValueError("Engine ID must contain only hex characters (0-9, a-f)")
    if len(v) % 2:
        raise ValueError("Engine ID must have an even number of hex characters")
    octets = len(v) // 2
    if octets < ENGINE_ID_MIN_OCTETS or octets > ENGINE_ID_MAX_OCTETS:
        raise ValueError(
            f"Engine ID must be {ENGINE_ID_MIN_OCTETS}-{ENGINE_ID_MAX_OCTETS} octets "
            f"({ENGINE_ID_MIN_OCTETS * 2}-{ENGINE_ID_MAX_OCTETS * 2} hex characters)"
        )
    return v


def validate_credential_ip(v: Optional[str]) -> str:
    """Shared IP/hostname validation for credential create and update."""
    if v is None:
        raise ValueError("IP address or hostname is required")
    v = v.strip()
    if not v:
        raise ValueError("IP address or hostname is required")
    if re.search(r'[\s;|&`$]', v):
        raise ValueError("IP address contains invalid characters")
    return v


class CredentialBase(BaseModel):
    label:        str
    ip:           str
    priority:     int  = 0
    snmp_port:    int  = 161
    enabled:      bool = True
    # False registers a ping-only host (the scan never tries SNMP)
    snmp_enabled: bool = True
    # v2c
    snmp_version: SnmpVersion  = "v2c"
    community:    str          = "public"
    # v3
    v3_security_level: SecurityLevel = "authPriv"
    v3_username:       str           = ""
    v3_auth_protocol:  AuthProtocol  = "SHA-256"
    v3_auth_password:  str           = ""
    v3_priv_protocol:  PrivProtocol  = "AES-128"
    v3_priv_password:  str           = ""
    # Optional manual override of the authoritative SNMPv3 engine ID (hex)
    v3_engine_id:      Optional[str] = None
    # Optional assignments
    profile_id:   Optional[int] = None
    device_id:    Optional[int] = None


class CredentialCreate(CredentialBase):

    @field_validator("v3_engine_id", mode="before")
    @classmethod
    def validate_engine_id(cls, v):
        return normalize_engine_id(v)

    @field_validator("ip")
    @classmethod
    def validate_ip(cls, v):
        return validate_credential_ip(v)


class CredentialUpdate(BaseModel):
    label:             Optional[str]           = None
    ip:                Optional[str]           = None
    priority:          Optional[int]           = None
    snmp_port:         Optional[int]           = None
    enabled:           Optional[bool]          = None
    snmp_enabled:      Optional[bool]          = None
    snmp_version:      Optional[SnmpVersion]   = None
    community:         Optional[str]           = None
    v3_security_level: Optional[SecurityLevel] = None
    v3_username:       Optional[str]           = None
    v3_auth_protocol:  Optional[AuthProtocol]  = None
    v3_auth_password:  Optional[str]           = None
    v3_priv_protocol:  Optional[PrivProtocol]  = None
    v3_priv_password:  Optional[str]           = None
    v3_engine_id:      Optional[str]           = None
    profile_id:        Optional[int]           = None
    device_id:         Optional[int]           = None

    @field_validator("v3_engine_id", mode="before")
    @classmethod
    def validate_engine_id(cls, v):
        # Empty string / None clears the override (back to discovery).
        return normalize_engine_id(v)

    @field_validator("ip")
    @classmethod
    def validate_ip(cls, v):
        # Only runs when "ip" is provided; an omitted ip leaves the value unchanged.
        return validate_credential_ip(v)


class CredentialOut(CredentialBase):
    id:         int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Read-only: last engine ID observed during a successful scan
    discovered_engine_id: Optional[str]      = None
    engine_id_seen_at:    Optional[datetime] = None

    @field_serializer("v3_auth_password", "v3_priv_password")
    def _mask_password(self, v: str) -> str:
        return MASK_API if v else ""

    @field_serializer("community")
    def _mask_community(self, v: str) -> str:
        return MASK_API if v else ""

    class Config:
        from_attributes = True


# ─── Port ─────────────────────────────────────────────────────────────────────

class PortOut(BaseModel):
    id:          int
    if_index:    Optional[int] = 0
    if_descr:    Optional[str] = ""
    if_alias:    Optional[str] = ""
    speed_mbps:  Optional[int] = 0
    oper_status: Optional[int] = 0
    endpoint_count: int = 0
    vlan:        Optional[int] = 0
    tagged_vlans: Optional[List[int]] = None
    # disabled|blocking|listening|learning|forwarding|broken (BRIDGE-MIB)
    stp_state:   Optional[str] = None
    # root|designated|blocked|disabled (derived from state and root port)
    stp_role:    Optional[str] = None
    stp_path_cost: Optional[int] = None

    @model_validator(mode="before")
    @classmethod
    def _coerce_nulls(cls, data):
        if hasattr(data, "__dict__"):
            # ORM object -- convert to dict-like via __dict__
            data = {k: v for k, v in data.__dict__.items() if not k.startswith("_")}
        if isinstance(data, dict):
            defaults = {
                "if_index": 0, "if_descr": "", "if_alias": "", "speed_mbps": 0,
                "oper_status": 0, "vlan": 0,
                "tagged_vlans": [],
            }
            for field, fallback in defaults.items():
                if data.get(field) is None:
                    data[field] = fallback
            # Compute endpoint_count from associations if present
            if "endpoint_count" not in data or data.get("endpoint_count") is None:
                assocs = data.get("endpoint_associations")
                data["endpoint_count"] = len(assocs) if assocs else 0
        return data

    class Config:
        from_attributes = True


# ─── Device ───────────────────────────────────────────────────────────────────

class DeviceBase(BaseModel):
    sys_name:  str
    ip:        str
    sys_descr: str = ""
    model:     str = ""
    firmware:  str = ""
    vendor:    str = ""
    location:  str = ""
    ping_status: str = "unknown"
    ping_rtt_ms: int = 0
    # True while the device is monitored by ping only (credential snmp_enabled=False)
    ping_only: bool = False
    map_x:     float = 100.0
    map_y:     float = 100.0
    ignored:   bool  = False
    label:     str   = ""
    enabled:   bool  = True
    vendor_override: bool = False
    latency_monitored: bool = False

    @field_validator("*", mode="before")
    @classmethod
    def _coerce_nulls(cls, v, info: ValidationInfo):
        """Replace NULL column values with the field's declared default.

        Field-level (not model-level) so it works for both dict input and
        ORM objects validated via ``from_attributes``: attribute access is
        left to Pydantic/SQLAlchemy, so expired ORM instances simply lazy-load
        instead of failing on a ``__dict__`` that no longer holds the columns.
        """
        if v is not None:
            return v
        field = cls.model_fields.get(info.field_name)
        if field is None:
            return v
        default = field.get_default(call_default_factory=True)
        # Required fields have no default -- leave None to fail validation
        # normally instead of silently inventing a value.
        if default is PydanticUndefined:
            return v
        return default


class StpInfo(BaseModel):
    """Bridge-level spanning tree summary (default instance)."""
    protocol:  str = "unknown"            # stp|rstp|mstp|unknown
    bridge_id: Optional[str] = None       # "<prio hex4>.<mac hex12>", e.g. "8000.aabbccddeeff"
    root_id:   Optional[str] = None
    root_cost: Optional[int] = None
    root_port: Optional[str] = None       # port name toward the root; None on the root bridge
    is_root:   bool = False


def build_stp_info(protocol, bridge_id, root_id, root_cost, root_port) -> Optional[StpInfo]:
    """Build StpInfo from the Device STP columns; None when no STP data exists."""
    if bridge_id is None and root_id is None and protocol is None:
        return None
    is_root = bool(bridge_id and root_id and bridge_id == root_id) or (
        not root_port and root_cost == 0
    )
    return StpInfo(
        protocol=protocol or "unknown",
        bridge_id=bridge_id,
        root_id=root_id,
        root_cost=root_cost,
        root_port=root_port or None,
        is_root=is_root,
    )


class DeviceOut(DeviceBase):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id:            int
    last_seen:     datetime
    ports:         List[PortOut] = []
    rack_id:       Optional[int] = None
    class_id:      Optional[int] = None
    model_id:      Optional[int] = None
    floor_id:      Optional[int] = None
    rack_u_position: Optional[int] = None
    u_height:      int = 1
    rack_side:     str = "front"          # "front" | "rear"
    full_depth:    bool = False           # occupies the U range on both sides
    ports_per_row: Optional[int] = None   # resolved from switch_model
    total_ports:   Optional[int] = None   # port cutoff: ports beyond this index are hidden
    stp:           Optional[StpInfo] = None
    vlan_names:    Dict[str, str] = Field(default_factory=dict)
    # Device kind ("switch" | "firewall" | "ups" | "server" | "other") and the
    # normalized health snapshot (see scanners.health), NULL when not reported.
    device_type:   str = "switch"
    health:        Optional[Dict[str, Any]] = None
    health_updated_at: Optional[datetime] = None

    # Raw Device STP columns: input only, folded into ``stp`` below.
    stp_protocol:  Optional[str] = Field(default=None, exclude=True)
    stp_bridge_id: Optional[str] = Field(default=None, exclude=True)
    stp_root_id:   Optional[str] = Field(default=None, exclude=True)
    stp_root_cost: Optional[int] = Field(default=None, exclude=True)
    stp_root_port: Optional[str] = Field(default=None, exclude=True)

    @field_validator("u_height", mode="before")
    @classmethod
    def _default_u_height(cls, v):
        # u_height is declared on DeviceOut (not DeviceBase); NULL must map
        # to the 1U default rather than fail the int validation.
        return 1 if v is None else v

    @field_validator("rack_side", mode="before")
    @classmethod
    def _default_rack_side(cls, v):
        return v or "front"

    @field_validator("full_depth", mode="before")
    @classmethod
    def _default_full_depth(cls, v):
        return bool(v)

    @field_validator("device_type", mode="before")
    @classmethod
    def _default_device_type(cls, v):
        return v or "switch"

    @field_validator("health", mode="before")
    @classmethod
    def _coerce_health(cls, v):
        return v if isinstance(v, dict) else None

    @field_validator("vlan_names", mode="before")
    @classmethod
    def _coerce_vlan_names(cls, v):
        if not isinstance(v, dict):
            return {}
        return {str(k): str(name) for k, name in v.items() if name is not None}

    @model_validator(mode="after")
    def _build_stp(self):
        if self.stp is None:
            self.stp = build_stp_info(
                self.stp_protocol, self.stp_bridge_id, self.stp_root_id,
                self.stp_root_cost, self.stp_root_port,
            )
        return self


class RackPositionUpdate(BaseModel):
    map_x: float
    map_y: float

class DevicePositionUpdate(BaseModel):
    map_x: float
    map_y: float


DeviceType = Literal["switch", "firewall", "ups", "server", "other"]


class DeviceMetaUpdate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    location: Optional[str] = None
    sys_name: Optional[str] = None
    vendor:   Optional[str] = None
    model:    Optional[str] = None
    rack_id:  Optional[int] = None
    class_id: Optional[int] = None
    model_id: Optional[int] = None
    # Floor of an unracked device; explicit null clears it
    floor_id: Optional[int] = None
    ignored:  Optional[bool] = None
    label:    Optional[str] = None
    enabled:  Optional[bool] = None
    rack_u_position: Optional[int] = Field(None, ge=1, le=48)
    u_height: Optional[int] = Field(None, ge=1, le=60)
    rack_side: Optional[RackSide] = None
    full_depth: Optional[bool] = None
    # Explicit control over the manual-vendor flag; wins over the implicit
    # derivation from the vendor field when both are sent.
    vendor_override: Optional[bool] = None
    # Opt-in for the latency monitor in latency_mode "selected".
    latency_monitored: Optional[bool] = None
    # Manual correction of the scan-derived device kind.
    device_type: Optional[DeviceType] = None


class BulkDeviceMetaUpdate(BaseModel):
    device_ids: List[int]
    ignored: Optional[bool] = None
    rack_id: Optional[int] = None
    class_id: Optional[int] = None
    # Explicitly unassign devices from their rack (rack_id cannot express this)
    clear_rack: bool = False
    floor_id: Optional[int] = None
    # Explicitly unassign devices from their floor (floor_id cannot express this)
    clear_floor: bool = False
    # Rack side / depth applied to all listed devices (placement is re-validated)
    rack_side: Optional[RackSide] = None
    full_depth: Optional[bool] = None


# ─── Endpoint ─────────────────────────────────────────────────────────────────

class EndpointPortInfo(BaseModel):
    """Port where an endpoint was seen."""
    port_id: int
    switch_ip: str = ""
    switch_name: str = ""
    port_name: str = ""
    vlan_id: Optional[int] = None
    last_seen: Optional[datetime] = None

    class Config:
        from_attributes = True


class EndpointOut(BaseModel):
    id: int
    mac: str
    ip: Optional[str] = None
    hostname: Optional[str] = None
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    ignored: bool = False
    notes: Optional[str] = None
    found_on: List[EndpointPortInfo] = []

    class Config:
        from_attributes = True


class EndpointUpdate(BaseModel):
    ignored: Optional[bool] = None
    notes: Optional[str] = None


class BulkEndpointUpdate(BaseModel):
    endpoint_ids: List[int]
    ignored: Optional[bool] = None


# ─── Ping-only adoption / ping candidates ─────────────────────────────────────

class PingOnlyEntry(BaseModel):
    # Validated per entry by the endpoint (one bad IP must not fail the batch)
    ip: str
    label: Optional[str] = None


class PingOnlyAdoptRequest(BaseModel):
    entries: List[PingOnlyEntry] = Field(..., max_length=500)


class PingOnlyCreated(BaseModel):
    ip: str
    credential_id: int
    device_id: int


class PingOnlySkipped(BaseModel):
    ip: str
    reason: Literal["exists", "invalid", "duplicate"]


class PingOnlyAdoptResult(BaseModel):
    created: List[PingOnlyCreated] = []
    skipped: List[PingOnlySkipped] = []


class PingCandidateOut(BaseModel):
    id: int
    ip: str
    rtt_ms: Optional[int] = None
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    hostname: Optional[str] = None
    mac: Optional[str] = None
    vendor: Optional[str] = None
    dismissed: bool = False


class PingCandidateIds(BaseModel):
    ids: List[int] = Field(..., max_length=5000)


# ─── Topology Link ────────────────────────────────────────────────────────────

class TopologyLinkOut(BaseModel):
    id:            int
    local_ip:      str
    local_port:    str
    remote_ip:     str
    remote_sys:    str
    remote_port:   str
    speed_label:   str
    discovered_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ─── Topology (full map) ──────────────────────────────────────────────────────

class TopologyOut(BaseModel):
    nodes:   List[DeviceOut]
    links:   List[TopologyLinkOut]
    racks:   List[RackOut]          = []
    classes: List[SwitchClassOut]   = []
    models:  List[SwitchModelOut]   = []
    buildings: List[BuildingOut]    = []


# ─── Scan ─────────────────────────────────────────────────────────────────────

class ScanSwitchMetric(BaseModel):
    ip:          str
    label:       str = ""
    duration_ms: int
    success:     bool = False
    error:       str = ""


class ScanRunOut(BaseModel):
    id:                int
    status:            str
    scanned:           int
    found:             int
    links:             int
    max_workers:       int
    total_duration_ms: int
    error_count:       int
    new_devices:       List[str] = []
    removed_devices:   List[str] = []
    new_links:         List[str] = []
    removed_links:     List[str] = []
    created_at:        Optional[datetime] = None
    switch_metrics:    List[ScanSwitchMetric] = []

    class Config:
        from_attributes = True


class ScanResult(BaseModel):
    scanned:            int
    found:              int
    links:              int
    errors:             List[str] = []
    max_workers:        int = 1
    total_duration_ms:  int = 0
    switch_metrics:     List[ScanSwitchMetric] = []
    status:             str = "unknown"
    run_id:             Optional[int] = None


class DryRunPreviewItem(BaseModel):
    ip: str
    sys_name: str = ""
    sys_descr: str = ""
    vendor: str = "generic"
    location: str = ""
    firmware: str = ""
    matched_profile_id: Optional[int] = None
    already_exists: bool = False


# Upper bound for import payloads (bulk and global config import).
IMPORT_DATA_MAX_LENGTH = 10 * 1024 * 1024


class BulkImportRequest(BaseModel):
    format: Literal["json", "csv"] = "json"
    data: str = Field(..., max_length=IMPORT_DATA_MAX_LENGTH)
    dry_run: bool = True


class BulkImportError(BaseModel):
    row: int
    message: str


class BulkImportResult(BaseModel):
    type: Literal["credentials", "profiles"]
    format: Literal["json", "csv"]
    dry_run: bool
    total_rows: int
    valid_rows: int
    inserted: int = 0
    updated: int = 0
    errors: List[BulkImportError] = []


class BulkExportOut(BaseModel):
    type: Literal["credentials", "profiles"]
    format: Literal["json", "csv"]
    data: str


class GlobalConfigExportOut(BaseModel):
    data: str


class GlobalConfigImportRequest(BaseModel):
    data: str = Field(..., max_length=IMPORT_DATA_MAX_LENGTH)
    dry_run: bool = True


# ─── Scan Settings ────────────────────────────────────────────────────────────

class ScanSettingsUpdate(BaseModel):
    max_workers: Optional[int] = None
    snmp_timeout: Optional[int] = None
    snmp_retries: Optional[int] = None
    snmp_bulk_size: Optional[int] = None
    # Days after which unseen endpoints are pruned; 0 disables pruning.
    endpoint_retention_days: Optional[int] = None

    @model_validator(mode="after")
    def _clamp_values(self):
        if self.max_workers is not None:
            self.max_workers = max(1, min(128, self.max_workers))
        if self.snmp_timeout is not None:
            self.snmp_timeout = max(1, min(30, self.snmp_timeout))
        if self.snmp_retries is not None:
            self.snmp_retries = max(0, min(10, self.snmp_retries))
        if self.snmp_bulk_size is not None:
            self.snmp_bulk_size = max(5, min(100, self.snmp_bulk_size))
        if self.endpoint_retention_days is not None:
            self.endpoint_retention_days = max(0, min(3650, self.endpoint_retention_days))
        return self

class ScanSettingsOut(BaseModel):
    max_workers: int
    snmp_timeout: int
    snmp_retries: int
    snmp_bulk_size: int = 25
    endpoint_retention_days: int = 30


# ─── DNS Settings ─────────────────────────────────────────────────────────────

class DnsSettingsUpdate(BaseModel):
    servers: List[str] = []

class DnsSettingsOut(BaseModel):
    servers: List[str]


# ─── Discovery Ranges ────────────────────────────────────────────────────────

class DiscoveryRangesUpdate(BaseModel):
    ranges: List[str] = []

class DiscoveryRangesOut(BaseModel):
    ranges: List[str]


# ─── Map Settings ─────────────────────────────────────────────────────────────

class MapSettingsUpdate(BaseModel):
    opacity: Optional[float] = None
    scale: Optional[float] = None
    bg_color: Optional[str] = None

    @model_validator(mode="after")
    def _clamp_and_sanitize(self):
        if self.opacity is not None:
            self.opacity = max(0.0, min(1.0, self.opacity))
        if self.scale is not None:
            self.scale = max(0.1, min(10.0, self.scale))
        if self.bg_color is not None:
            self.bg_color = self.bg_color[:20]
        return self

class MapSettingsOut(BaseModel):
    opacity: float
    scale: float
    bg_color: str


# ─── Latency monitor ──────────────────────────────────────────────────────────

LatencyStatus = Literal["ok", "degraded", "loss", "down", "unknown"]


class LatencyNetworkOut(BaseModel):
    median_ms: Optional[float] = None
    p95_ms:    Optional[float] = None
    loss_pct:  Optional[float] = None
    targets:   int = 0
    reachable: int = 0
    degraded:  int = 0


class LatencyDeviceOut(BaseModel):
    device_id:   int
    name:        str
    ip:          str
    rtt_ms:      Optional[float] = None
    jitter_ms:   Optional[float] = None
    loss_pct:    Optional[float] = None
    baseline_ms: Optional[float] = None
    status:      LatencyStatus = "unknown"
    updated_at:  Optional[str] = None


class LatencySummaryOut(BaseModel):
    enabled:       bool
    interval_sec:  int
    mode:          Literal["all", "selected"]
    monitor_alive: bool
    updated_at:    Optional[str] = None
    network:       LatencyNetworkOut
    devices:       List[LatencyDeviceOut]


class LatencyHistoryPoint(BaseModel):
    ts:        str
    rtt_ms:    Optional[float] = None
    jitter_ms: Optional[float] = None
    loss_pct:  Optional[float] = None


class LatencyHistoryOut(BaseModel):
    range:      Literal["1h", "24h", "7d"]
    device_id:  Optional[int] = None
    bucket_sec: int
    points:     List[LatencyHistoryPoint]
