"""Discovery scan range helpers: normalization, schedule math and DB queries.

Kept free of scan_engine/pysnmp imports so routers, the scheduler and the
scan executor can share them.
"""
import ipaddress
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from sqlalchemy.orm import Session

from database import AppSetting, ScanRange

SCAN_RANGE_MAX_ADDRESSES = 65536
DEFAULT_DISCOVERY_INTERVAL_SEC = 1800


class ScanRangeError(ValueError):
    """Invalid scan range entry; ``code`` is the API error code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def normalize_scan_range(entry) -> str:
    """Normalize a CIDR network or single IP.

    Networks become str(ip_network(x, strict=False)); a single address (also a
    /32 or /128 network) becomes the plain IP. Raises ScanRangeError with code
    INVALID_IP_RANGE or RANGE_TOO_LARGE (> 65536 addresses).
    """
    text = str(entry if entry is not None else "").strip()
    try:
        network = ipaddress.ip_network(text, strict=False)
    except ValueError:
        raise ScanRangeError("INVALID_IP_RANGE", f"Invalid IP or CIDR range: {text}")
    if network.num_addresses > SCAN_RANGE_MAX_ADDRESSES:
        raise ScanRangeError(
            "RANGE_TOO_LARGE",
            f"Range {text} has {network.num_addresses} addresses (maximum {SCAN_RANGE_MAX_ADDRESSES})",
        )
    if network.num_addresses == 1:
        return str(network.network_address)
    return str(network)


def range_ips(cidr: str) -> List[str]:
    """Usable host addresses of a normalized range (the IP itself for a single host)."""
    try:
        network = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return []
    if network.num_addresses > SCAN_RANGE_MAX_ADDRESSES:
        return []
    if network.num_addresses == 1:
        return [str(network.network_address)]
    return [str(ip) for ip in network.hosts()]


def scan_range_host_count(cidr: str) -> int:
    """Number of usable host addresses of a normalized range (1 for a single IP)."""
    try:
        network = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return 0
    if network.num_addresses == 1:
        return 1
    return sum(1 for _ in network.hosts())


def read_global_discovery_interval(db: Session) -> int:
    """Global discovery_interval_sec app setting (default 1800)."""
    row = db.query(AppSetting).filter(AppSetting.key == "discovery_interval_sec").first()
    try:
        return int(row.value) if row and row.value is not None else DEFAULT_DISCOVERY_INTERVAL_SEC
    except (TypeError, ValueError):
        return DEFAULT_DISCOVERY_INTERVAL_SEC


def effective_range_interval(interval_sec: Optional[int], global_interval: int) -> int:
    """Per-range interval, else the global discovery interval (1800 when unset/<= 0)."""
    if interval_sec is not None and interval_sec > 0:
        return int(interval_sec)
    if global_interval and global_interval > 0:
        return int(global_interval)
    return DEFAULT_DISCOVERY_INTERVAL_SEC


def naive_utc(value: Optional[datetime]) -> Optional[datetime]:
    """Convert to naive UTC (the storage convention of last_scan_at)."""
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def range_is_due(last_scan_at: Optional[datetime], interval: int, now: Optional[datetime] = None) -> bool:
    """True when a range was never scanned or its interval has elapsed."""
    last = naive_utc(last_scan_at)
    if last is None:
        return True
    now = naive_utc(now) or utcnow_naive()
    return (now - last).total_seconds() >= interval


def range_next_scan_at(row, global_interval: int) -> Optional[datetime]:
    """last_scan_at + effective interval; None when disabled or never scanned."""
    if not row.enabled or row.last_scan_at is None:
        return None
    return naive_utc(row.last_scan_at) + timedelta(
        seconds=effective_range_interval(row.interval_sec, global_interval)
    )


def clean_profile_ids(value) -> List[int]:
    """Deduplicated integer profile ids from a JSON value (non-lists -> [])."""
    if not isinstance(value, list):
        return []
    result: List[int] = []
    for item in value:
        try:
            pid = int(item)
        except (TypeError, ValueError):
            continue
        if pid not in result:
            result.append(pid)
    return result


def load_scan_ranges(db: Session, due_only: bool, now: Optional[datetime] = None) -> List[dict]:
    """Enabled scan ranges as plain dicts {id, cidr, profile_ids, interval, last_scan_at}.

    ``due_only`` keeps only ranges never scanned or whose effective interval
    has elapsed since last_scan_at.
    """
    now = naive_utc(now) or utcnow_naive()
    global_interval = read_global_discovery_interval(db)
    result: List[dict] = []
    rows = db.query(ScanRange).filter(ScanRange.enabled.is_(True)).order_by(ScanRange.cidr).all()
    for row in rows:
        interval = effective_range_interval(row.interval_sec, global_interval)
        if due_only and not range_is_due(row.last_scan_at, interval, now):
            continue
        result.append({
            "id": row.id,
            "cidr": row.cidr,
            "profile_ids": clean_profile_ids(row.profile_ids),
            "interval": interval,
            "last_scan_at": naive_utc(row.last_scan_at),
        })
    return result


def any_scan_range_due(db: Session, now: Optional[datetime] = None) -> bool:
    """True when at least one enabled range is due for a scheduled scan."""
    return bool(load_scan_ranges(db, due_only=True, now=now))


def enabled_range_cidrs(db: Session) -> List[str]:
    """CIDRs of all enabled scan ranges ordered by CIDR."""
    rows = db.query(ScanRange.cidr).filter(ScanRange.enabled.is_(True)).order_by(ScanRange.cidr).all()
    return [row[0] for row in rows]


def all_range_cidrs(db: Session) -> List[str]:
    """CIDRs of all scan ranges (enabled or not) ordered by CIDR."""
    return [row[0] for row in db.query(ScanRange.cidr).order_by(ScanRange.cidr).all()]


def mark_ranges_scanned(db: Session, range_ids, now: Optional[datetime] = None) -> None:
    """Set last_scan_at = now on the given ranges. The caller commits."""
    ids = [int(i) for i in range_ids]
    if not ids:
        return
    stamp = naive_utc(now) or utcnow_naive()
    db.query(ScanRange).filter(ScanRange.id.in_(ids)).update(
        {ScanRange.last_scan_at: stamp}, synchronize_session=False,
    )
