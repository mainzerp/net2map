"""Ping candidates: discovery-range hosts that answered ping but no SNMP profile.

Rows are written by the scan finalize step (scan_engine.executor). The list
hides hosts that meanwhile have a Device or a Credential (adopted via
POST /credentials/ping-only or discovered otherwise).
"""
import ipaddress
from typing import List

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from database import Credential, Device, Endpoint, PingCandidate, get_db
from schemas import PingCandidateIds, PingCandidateOut
from shared.audit import log_audit
from shared.auth import require_role

router = APIRouter()


def _ip_sort_key(ip: str) -> tuple:
    """Numeric order for IPv4/IPv6 addresses; anything else sorts after them by string."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return (2, 0, ip)
    return (0 if addr.version == 4 else 1, int(addr), ip)


@router.get("/ping-candidates", response_model=List[PingCandidateOut])
def list_ping_candidates(include_dismissed: bool = False, db: Session = Depends(get_db)):
    query = db.query(PingCandidate)
    if not include_dismissed:
        query = query.filter(PingCandidate.dismissed.is_(False))
    candidates = query.all()
    if not candidates:
        return []
    ips = [c.ip for c in candidates]
    known = {row[0] for row in db.query(Device.ip).filter(Device.ip.in_(ips)).all()}
    known |= {row[0] for row in db.query(Credential.ip).filter(Credential.ip.in_(ips)).all()}

    # Most recently seen endpoint per IP (rows ordered oldest first, later rows win)
    endpoint_by_ip = {}
    for ep in (
        db.query(Endpoint)
        .filter(Endpoint.ip.in_(ips))
        .order_by(Endpoint.last_seen.asc().nulls_first(), Endpoint.id.asc())
        .all()
    ):
        endpoint_by_ip[ep.ip] = ep

    out = []
    for cand in sorted(candidates, key=lambda c: _ip_sort_key(c.ip)):
        if cand.ip in known:
            continue
        ep = endpoint_by_ip.get(cand.ip)
        out.append(PingCandidateOut(
            id=cand.id,
            ip=cand.ip,
            rtt_ms=cand.rtt_ms,
            first_seen=cand.first_seen,
            last_seen=cand.last_seen,
            hostname=(ep.hostname or None) if ep else None,
            mac=(ep.mac or None) if ep else None,
            # Endpoints carry no OUI vendor column; reserved for a later lookup
            vendor=None,
            dismissed=bool(cand.dismissed),
        ))
    return out


def _set_dismissed(db: Session, ids: List[int], dismissed: bool) -> int:
    if not ids:
        return 0
    count = (
        db.query(PingCandidate)
        .filter(PingCandidate.id.in_(set(ids)), PingCandidate.dismissed.is_(not dismissed))
        .update({PingCandidate.dismissed: dismissed}, synchronize_session=False)
    )
    db.commit()
    return count


@router.post("/ping-candidates/dismiss", dependencies=[require_role("admin", "operator")])
def dismiss_ping_candidates(body: PingCandidateIds, request: Request, db: Session = Depends(get_db)):
    count = _set_dismissed(db, body.ids, True)
    if count:
        log_audit(request, "dismiss", "ping_candidate", "", {"ids": sorted(set(body.ids)), "count": count})
    return {"dismissed": count}


@router.post("/ping-candidates/restore", dependencies=[require_role("admin", "operator")])
def restore_ping_candidates(body: PingCandidateIds, request: Request, db: Session = Depends(get_db)):
    count = _set_dismissed(db, body.ids, False)
    if count:
        log_audit(request, "restore", "ping_candidate", "", {"ids": sorted(set(body.ids)), "count": count})
    return {"restored": count}
