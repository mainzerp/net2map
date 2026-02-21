"""Pydantic schemas for request / response validation."""
from datetime import datetime
from typing import Literal, Optional, List
from pydantic import BaseModel

# ─── Enums ────────────────────────────────────────────────────────────────────
SnmpVersion   = Literal["v2c", "v3"]
SecurityLevel = Literal["noAuthNoPriv", "authNoPriv", "authPriv"]
AuthProtocol  = Literal["MD5", "SHA", "SHA-224", "SHA-256", "SHA-384", "SHA-512"]
PrivProtocol  = Literal["DES", "3DES", "AES-128", "AES-192", "AES-256"]


# ─── Rack ─────────────────────────────────────────────────────────────────────

class RackBase(BaseModel):
    label:       str
    room:        str = ""
    description: str = ""


class RackCreate(RackBase):
    pass


class RackUpdate(BaseModel):
    label:       Optional[str] = None
    room:        Optional[str] = None
    description: Optional[str] = None


class RackOut(RackBase):
    id:         int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ─── SwitchClass ──────────────────────────────────────────────────────────────

class SwitchClassBase(BaseModel):
    label:       str
    description: str = ""
    color:       str = "#64748b"


class SwitchClassCreate(SwitchClassBase):
    pass


class SwitchClassUpdate(BaseModel):
    label:       Optional[str] = None
    description: Optional[str] = None
    color:       Optional[str] = None


class SwitchClassOut(SwitchClassBase):
    id:         int
    created_at: datetime
    updated_at: datetime

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
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ─── Credential ───────────────────────────────────────────────────────────────

class CredentialBase(BaseModel):
    label:        str
    ip:           str
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


class CredentialCreate(CredentialBase):
    pass


class CredentialUpdate(BaseModel):
    label:             Optional[str]           = None
    ip:                Optional[str]           = None
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


class CredentialOut(CredentialBase):
    id:         int
    profile_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ─── Port ─────────────────────────────────────────────────────────────────────

class PortOut(BaseModel):
    id:          int
    if_index:    int
    if_descr:    str
    if_alias:    str
    speed_mbps:  int
    oper_status: int
    peer_mac:    str
    peer_ip:     str
    peer_host:   str
    vlan:        int

    class Config:
        from_attributes = True


# ─── Device ───────────────────────────────────────────────────────────────────

class DeviceBase(BaseModel):
    sys_name:  str
    ip:        str
    sys_descr: str = ""
    model:     str = ""
    vendor:    str = ""
    location:  str = ""
    map_x:     float = 100.0
    map_y:     float = 100.0


class DeviceOut(DeviceBase):
    id:        int
    last_seen: datetime
    ports:     List[PortOut] = []
    rack_id:   Optional[int] = None
    class_id:  Optional[int] = None

    class Config:
        from_attributes = True


class DevicePositionUpdate(BaseModel):
    map_x: float
    map_y: float


class DeviceMetaUpdate(BaseModel):
    location: Optional[str] = None
    sys_name: Optional[str] = None
    vendor:   Optional[str] = None
    model:    Optional[str] = None
    rack_id:  Optional[int] = None
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
    discovered_at: datetime

    class Config:
        from_attributes = True


# ─── Topology (full map) ──────────────────────────────────────────────────────

class TopologyOut(BaseModel):
    nodes:   List[DeviceOut]
    links:   List[TopologyLinkOut]
    racks:   List[RackOut]          = []
    classes: List[SwitchClassOut]   = []


# ─── Scan ─────────────────────────────────────────────────────────────────────

class ScanSwitchMetric(BaseModel):
    ip:          str
    label:       str = ""
    duration_ms: int
    success:     bool = False
    error:       str = ""


class ScanResult(BaseModel):
    scanned:            int
    found:              int
    links:              int
    errors:             List[str] = []
    max_workers:        int = 1
    total_duration_ms:  int = 0
    switch_metrics:     List[ScanSwitchMetric] = []
