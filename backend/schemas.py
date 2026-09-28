"""Pydantic schemas for request / response validation."""
import re
from datetime import datetime
from typing import List, Literal, Optional

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

class LoginRequest(BaseModel):
    username: str
    password: str

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
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters long")
        return v

class UserUpdate(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None

    @field_validator("password")
    @classmethod
    def validate_password(cls, v):
        if v is not None and len(v) < 8:
            raise ValueError("Password must be at least 8 characters long")
        return v

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


class RackCreate(RackBase):
    pass


class RackUpdate(BaseModel):
    label:       Optional[str] = None
    room:        Optional[str] = None
    description: Optional[str] = None
    map_x:       Optional[float] = None
    map_y:       Optional[float] = None
    height_u:    Optional[int] = Field(None, ge=6, le=60)


class RackOut(RackBase):
    id:         int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class RackLayoutEntry(BaseModel):
    """Placement of one device in the rack elevation (1-based U space)."""
    device_id:       int
    rack_u_position: int = Field(..., ge=1, le=48)
    u_height:        int = Field(..., ge=1, le=60)


class RackLayoutIn(BaseModel):
    entries: List[RackLayoutEntry]


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

class CredentialBase(BaseModel):
    label:        str
    ip:           str
    priority:     int  = 0
    snmp_port:    int  = 161
    enabled:      bool = True
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
    # Optional assignments
    profile_id:   Optional[int] = None
    device_id:    Optional[int] = None


class CredentialCreate(CredentialBase):

    @field_validator("ip")
    @classmethod
    def validate_ip(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("IP address or hostname is required")
        if re.search(r'[\s;|&`$]', v):
            raise ValueError("IP address contains invalid characters")
        return v


class CredentialUpdate(BaseModel):
    label:             Optional[str]           = None
    ip:                Optional[str]           = None
    priority:          Optional[int]           = None
    snmp_port:         Optional[int]           = None
    enabled:           Optional[bool]          = None
    snmp_version:      Optional[SnmpVersion]   = None
    community:         Optional[str]           = None
    v3_security_level: Optional[SecurityLevel] = None
    v3_username:       Optional[str]           = None
    v3_auth_protocol:  Optional[AuthProtocol]  = None
    v3_auth_password:  Optional[str]           = None
    v3_priv_protocol:  Optional[PrivProtocol]  = None
    v3_priv_password:  Optional[str]           = None
    profile_id:        Optional[int]           = None
    device_id:         Optional[int]           = None


class CredentialOut(CredentialBase):
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
    map_x:     float = 100.0
    map_y:     float = 100.0
    ignored:   bool  = False
    label:     str   = ""
    enabled:   bool  = True
    vendor_override: bool = False

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


class DeviceOut(DeviceBase):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id:            int
    last_seen:     datetime
    ports:         List[PortOut] = []
    rack_id:       Optional[int] = None
    class_id:      Optional[int] = None
    model_id:      Optional[int] = None
    rack_u_position: Optional[int] = None
    u_height:      int = 1
    ports_per_row: Optional[int] = None   # resolved from switch_model
    total_ports:   Optional[int] = None   # port cutoff: ports beyond this index are hidden

    @field_validator("u_height", mode="before")
    @classmethod
    def _default_u_height(cls, v):
        # u_height is declared on DeviceOut (not DeviceBase); NULL must map
        # to the 1U default rather than fail the int validation.
        return 1 if v is None else v


class RackPositionUpdate(BaseModel):
    map_x: float
    map_y: float

class DevicePositionUpdate(BaseModel):
    map_x: float
    map_y: float


class DeviceMetaUpdate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    location: Optional[str] = None
    sys_name: Optional[str] = None
    vendor:   Optional[str] = None
    model:    Optional[str] = None
    rack_id:  Optional[int] = None
    class_id: Optional[int] = None
    model_id: Optional[int] = None
    ignored:  Optional[bool] = None
    label:    Optional[str] = None
    enabled:  Optional[bool] = None
    rack_u_position: Optional[int] = Field(None, ge=1, le=48)
    u_height: Optional[int] = Field(None, ge=1, le=60)
    # Explicit control over the manual-vendor flag; wins over the implicit
    # derivation from the vendor field when both are sent.
    vendor_override: Optional[bool] = None


class BulkDeviceMetaUpdate(BaseModel):
    device_ids: List[int]
    ignored: Optional[bool] = None
    rack_id: Optional[int] = None
    class_id: Optional[int] = None
    # Explicitly unassign devices from their rack (rack_id cannot express this)
    clear_rack: bool = False


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


class BulkImportRequest(BaseModel):
    format: Literal["json", "csv"] = "json"
    data: str
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
    data: str
    dry_run: bool = True


# ─── Scan Settings ────────────────────────────────────────────────────────────

class ScanSettingsUpdate(BaseModel):
    max_workers: Optional[int] = None
    snmp_timeout: Optional[int] = None
    snmp_retries: Optional[int] = None

    @model_validator(mode="after")
    def _clamp_values(self):
        if self.max_workers is not None:
            self.max_workers = max(1, min(128, self.max_workers))
        if self.snmp_timeout is not None:
            self.snmp_timeout = max(1, min(30, self.snmp_timeout))
        if self.snmp_retries is not None:
            self.snmp_retries = max(0, min(10, self.snmp_retries))
        return self

class ScanSettingsOut(BaseModel):
    max_workers: int
    snmp_timeout: int
    snmp_retries: int


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
