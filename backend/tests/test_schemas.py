"""Tests for Pydantic schema validation."""
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from database import Device, Port
from schemas import (
    APIError,
    BulkEndpointUpdate,
    CredentialCreate,
    DeviceOut,
    DnsSettingsUpdate,
    EndpointOut,
    EndpointPortInfo,
    EndpointUpdate,
    ErrorDetail,
    MapSettingsUpdate,
    ScanSettingsUpdate,
)


def test_credential_create_defaults():
    c = CredentialCreate(label="SW1", ip="10.0.0.1")
    assert c.snmp_port == 161
    assert c.community == "public"
    assert c.snmp_version == "v2c"


def test_credential_create_rejects_invalid_snmp_version():
    with pytest.raises(ValidationError):
        CredentialCreate(label="SW1", ip="10.0.0.1", snmp_version="v4")


def test_scan_settings_update_defaults():
    s = ScanSettingsUpdate()
    assert s.max_workers is None
    assert s.snmp_timeout is None
    assert s.snmp_retries is None


def test_dns_settings_update():
    d = DnsSettingsUpdate(servers=["8.8.8.8", "1.1.1.1"])
    assert len(d.servers) == 2


def test_map_settings_update():
    m = MapSettingsUpdate(opacity=0.5)
    assert m.opacity == 0.5
    assert m.scale is None


def test_error_detail_minimal():
    e = ErrorDetail(code="TEST", message="test error")
    assert e.field is None
    assert e.details is None


def test_api_error_structure():
    ae = APIError(error=ErrorDetail(code="NOT_FOUND", message="not found"))
    assert ae.error.code == "NOT_FOUND"


def test_scan_settings_clamps_max_workers():
    s = ScanSettingsUpdate(max_workers=999)
    assert s.max_workers == 128
    s2 = ScanSettingsUpdate(max_workers=0)
    assert s2.max_workers == 1


def test_scan_settings_clamps_snmp_timeout():
    s = ScanSettingsUpdate(snmp_timeout=100)
    assert s.snmp_timeout == 30
    s2 = ScanSettingsUpdate(snmp_timeout=-5)
    assert s2.snmp_timeout == 1


def test_scan_settings_clamps_snmp_retries():
    s = ScanSettingsUpdate(snmp_retries=50)
    assert s.snmp_retries == 10
    s2 = ScanSettingsUpdate(snmp_retries=-1)
    assert s2.snmp_retries == 0


def test_map_settings_clamps_opacity():
    m = MapSettingsUpdate(opacity=5.0)
    assert m.opacity == 1.0
    m2 = MapSettingsUpdate(opacity=-0.5)
    assert m2.opacity == 0.0


def test_map_settings_clamps_scale():
    m = MapSettingsUpdate(scale=100.0)
    assert m.scale == 10.0
    m2 = MapSettingsUpdate(scale=0.01)
    assert m2.scale == 0.1


def test_map_settings_truncates_bg_color():
    m = MapSettingsUpdate(bg_color="a" * 50)
    assert len(m.bg_color) == 20


# ── Endpoint schemas ──────────────────────────────────────────────────────────

def test_endpoint_out_defaults():
    ep = EndpointOut(id=1, mac="aa:bb:cc:dd:ee:ff")
    assert ep.ip is None
    assert ep.hostname is None
    assert ep.ignored is False
    assert ep.notes is None
    assert ep.found_on == []


def test_endpoint_port_info():
    info = EndpointPortInfo(port_id=1, switch_ip="10.0.0.1", switch_name="sw1", port_name="eth0")
    assert info.vlan_id is None
    assert info.last_seen is None


def test_endpoint_update_partial():
    u = EndpointUpdate(ignored=True)
    assert u.ignored is True
    assert u.notes is None


def test_bulk_endpoint_update():
    b = BulkEndpointUpdate(endpoint_ids=[1, 2, 3], ignored=True)
    assert len(b.endpoint_ids) == 3
    assert b.ignored is True


# ── Device schemas ────────────────────────────────────────────────────────────

def test_device_out_validates_expired_orm_object(db):
    """An expired ORM Device still validates: attributes lazy-load on access."""
    device = Device(ip="10.9.9.1", sys_name="sw-expired")
    db.add(device)
    db.commit()
    db.add(Port(device_id=device.id, if_index=1, if_descr="eth1", oper_status=1))
    db.commit()
    db.expire(device)  # drop all loaded column state; access must lazy-load

    out = DeviceOut.model_validate(device)
    assert out.sys_name == "sw-expired"
    assert out.firmware == ""
    assert out.u_height == 1
    assert len(out.ports) == 1
    assert out.ports[0].if_descr == "eth1"


def test_device_out_dict_null_firmware_coerces_to_empty():
    """A dict payload with firmware=None is coerced to the field default ''."""
    out = DeviceOut.model_validate({
        "id": 1,
        "sys_name": "sw1",
        "ip": "10.9.9.2",
        "firmware": None,
        "last_seen": datetime.now(timezone.utc),
    })
    assert out.firmware == ""


def test_device_out_required_field_still_required():
    """None for a required field (no default) still fails validation."""
    with pytest.raises(ValidationError):
        DeviceOut.model_validate({
            "id": 1,
            "sys_name": None,
            "ip": "10.9.9.3",
            "last_seen": datetime.now(timezone.utc),
        })
