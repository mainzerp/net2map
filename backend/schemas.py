"""Pydantic schemas for request / response validation."""
from datetime import datetime
from typing import Any, Literal, Optional, List
from pydantic import BaseModel, ConfigDict, field_serializer, model_validator


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

class UserUpdate(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None

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


class RackCreate(RackBase):
    pass


class RackUpdate(BaseModel):
    label:       Optional[str] = None
    room:        Optional[str] = None
    description: Optional[str] = None
    map_x:       Optional[float] = None
    map_y:       Optional[float] = None


class RackOut(RackBase):
    id:         int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


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
        return "***" if v else ""

    class Config:
        from_attributes = True


# ─── Credential ───────────────────────────────────────────────────────────────

class CredentialBase(BaseModel):
    label:        str
    ip:           str
    priority:     int  = 0
    snmp_port:    int  = 161
    location:     str  = ""
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
    rack_id:      Optional[int] = None
    class_id:     Optional[int] = None
    vendor:       str = ""
    model:        str = ""


class CredentialCreate(CredentialBase):
    pass


class CredentialUpdate(BaseModel):
    label:             Optional[str]           = None
    ip:                Optional[str]           = None
    priority:          Optional[int]           = None
    snmp_port:         Optional[int]           = None
    location:          Optional[str]           = None
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
    rack_id:           Optional[int]           = None
    class_id:          Optional[int]           = None
    vendor:            Optional[str]           = None
    model:             Optional[str]           = None


class CredentialOut(CredentialBase):
    id:         int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @field_serializer("v3_auth_password", "v3_priv_password")
    def _mask_password(self, v: str) -> str:
        return "***" if v else ""

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
    peer_mac:    Optional[str] = ""
    peer_ip:     Optional[str] = ""
    peer_host:   Optional[str] = ""
    endpoint_count:        Optional[int] = 0
    endpoint_details_json: Any = []
    vlan:        Optional[int] = 0
    tagged_vlans: Optional[List[int]] = None

    @model_validator(mode="before")
    @classmethod
    def _coerce_nulls(cls, data):
        if hasattr(data, "__dict__"):
            # ORM object — convert to dict-like via __dict__
            data = {k: v for k, v in data.__dict__.items() if not k.startswith("_")}
        if isinstance(data, dict):
            defaults = {
                "if_index": 0, "if_descr": "", "if_alias": "", "speed_mbps": 0,
                "oper_status": 0, "peer_mac": "", "peer_ip": "", "peer_host": "",
                "endpoint_count": 0, "endpoint_details_json": [], "vlan": 0,
                "tagged_vlans": [],
            }
            for field, fallback in defaults.items():
                if data.get(field) is None:
                    data[field] = fallback
        return data

    class Config:
        from_attributes = True


class FoundOnPort(BaseModel):
    """Where an endpoint device was discovered (switch + port)."""
    switch_name: str = ""
    switch_ip: str = ""
    port_name: str = ""
    port_id: int = 0
    rack_id: Optional[int] = None
    peer_mac: str = ""
    peer_host: str = ""


# ─── Device ───────────────────────────────────────────────────────────────────

class DeviceBase(BaseModel):
    sys_name:  str
    ip:        str
    sys_descr: str = ""
    model:     str = ""
    vendor:    str = ""
    location:  str = ""
    ping_status: str = "unknown"
    ping_rtt_ms: int = 0
    map_x:     float = 100.0
    map_y:     float = 100.0
    ignored:   bool  = False


class DeviceOut(DeviceBase):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id:            int
    last_seen:     datetime
    ports:         List[PortOut] = []
    rack_id:       Optional[int] = None
    class_id:      Optional[int] = None
    model_id:      Optional[int] = None
    ports_per_row: Optional[int] = None   # resolved from switch_model
    total_ports:   Optional[int] = None   # port cutoff: ports beyond this index are hidden
    found_on:      Optional[FoundOnPort] = None


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


class BulkDeviceMetaUpdate(BaseModel):
    device_ids: List[int]
    ignored: Optional[bool] = None
    rack_id: Optional[int] = None
    class_id: Optional[int] = None


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
