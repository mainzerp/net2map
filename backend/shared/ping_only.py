"""Ping-only device helpers shared by the scan executor and the credentials API.

A ping-only host is registered through a Credential with snmp_enabled=False.
The scan never queries it via SNMP; its Device row is created and updated from
ping results alone.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from database import Credential, Device

PING_ONLY_SYS_DESCR = "Ping-only device (SNMP disabled)"
PING_ONLY_DEVICE_TYPE = "other"


def upsert_ping_only_device(
    db: Session,
    ip: str,
    device: Optional[Device],
    cred: Optional[Credential],
    label: str,
    ping_ok: Optional[bool],
    ping_rtt: int,
    position: tuple,
) -> Device:
    """Create or update the Device of a ping-only host (credential snmp_enabled=False).

    A missing Device is created regardless of the ping result because the host
    was registered explicitly. An existing Device only gets its ping state and
    the ping_only flag updated; name, vendor, rack, class and floor are kept.

    ``ping_ok=None`` means the host has not been pinged yet (registered via the
    API): a new Device gets ping_status "unknown" and an existing Device keeps
    its current ping state until the next scan.

    The caller commits (the scan executor commits lease-guarded).
    """
    now = datetime.now(timezone.utc)
    if device is None:
        device = Device(
            ip=ip,
            sys_name=label or ip,
            sys_descr=PING_ONLY_SYS_DESCR,
            vendor="",
            device_type=PING_ONLY_DEVICE_TYPE,
            ping_only=True,
            map_x=position[0],
            map_y=position[1],
            label=label,
            enabled=True,
        )
        if ping_ok is None:
            device.ping_status = "unknown"
            device.ping_rtt_ms = 0
        # last_seen keeps its column default (creation time): DeviceOut
        # requires a value even for a host that never answered.
        db.add(device)
        db.flush()
    else:
        device.ping_only = True
        if not device.label and label:
            device.label = label
        if ping_ok:
            device.last_seen = now
    if ping_ok is not None:
        device.ping_status = "online" if ping_ok else "offline"
        device.ping_rtt_ms = ping_rtt if ping_ok else 0
        device.last_ping = now
    if cred is not None and not cred.device_id:
        cred.device_id = device.id
    return device
