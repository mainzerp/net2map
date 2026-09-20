"""CRUD endpoints for discovered endpoint devices."""
import hashlib
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy import case, func
from sqlalchemy.orm import Session, joinedload

from database import Endpoint, EndpointPortAssociation, Port, get_db
from schemas import BulkEndpointUpdate, EndpointOut, EndpointPortInfo, EndpointUpdate
from shared.audit import log_audit
from shared.auth import require_role
from shared.errors import api_error

router = APIRouter()


def _build_endpoint_out(ep: Endpoint) -> EndpointOut:
    found_on = []
    for assoc in ep.port_associations:
        port = assoc.port
        if not port:
            continue
        device = port.device if port else None
        found_on.append(EndpointPortInfo(
            port_id=port.id,
            switch_ip=device.ip if device else "",
            switch_name=device.sys_name if device else "",
            port_name=port.if_descr or "",
            vlan_id=assoc.vlan_id,
            last_seen=assoc.last_seen,
        ))
    return EndpointOut(
        id=ep.id,
        mac=ep.mac,
        ip=ep.ip,
        hostname=ep.hostname,
        first_seen=ep.first_seen,
        last_seen=ep.last_seen,
        ignored=ep.ignored,
        notes=ep.notes,
        found_on=found_on,
    )


def _endpoint_list_etag(db: Session) -> str:
    """Cheap change indicator for the endpoint list without materializing rows.

    Covers endpoint inserts/deletes, scan sightings (last_seen), ignored/notes
    edits, and port-association changes. Does not detect renames of linked
    ports/devices; those are rare and covered by the next scan.
    """
    ep_count, ep_max_id, ep_max_seen, ep_ignored, ep_notes_len = db.query(
        func.count(Endpoint.id),
        func.max(Endpoint.id),
        func.max(Endpoint.last_seen),
        func.sum(case((Endpoint.ignored, 1), else_=0)),
        func.sum(func.length(func.coalesce(Endpoint.notes, ""))),
    ).one()
    as_count, as_max_id, as_max_seen = db.query(
        func.count(EndpointPortAssociation.id),
        func.max(EndpointPortAssociation.id),
        func.max(EndpointPortAssociation.last_seen),
    ).one()
    raw = (
        f"{ep_count}:{ep_max_id}:{ep_max_seen}:{ep_ignored}:{ep_notes_len}"
        f":{as_count}:{as_max_id}:{as_max_seen}"
    )
    return f'"{hashlib.sha256(raw.encode()).hexdigest()[:32]}"'


@router.get("/api/endpoints")
def list_endpoints(request: Request, db: Session = Depends(get_db)):
    etag = _endpoint_list_etag(db)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    endpoints = (
        db.query(Endpoint)
        .options(
            joinedload(Endpoint.port_associations)
            .joinedload(EndpointPortAssociation.port)
            .joinedload(Port.device)
        )
        .order_by(Endpoint.mac)
        .all()
    )
    result = [_build_endpoint_out(ep) for ep in endpoints]
    body = json.dumps([e.model_dump() for e in result], default=str)
    return Response(content=body, media_type="application/json",
                    headers={"ETag": etag, "Cache-Control": "no-cache"})


@router.get("/api/endpoints/{endpoint_id}")
def get_endpoint(endpoint_id: int, db: Session = Depends(get_db)):
    ep = (
        db.query(Endpoint)
        .options(
            joinedload(Endpoint.port_associations)
            .joinedload(EndpointPortAssociation.port)
            .joinedload(Port.device)
        )
        .filter(Endpoint.id == endpoint_id)
        .first()
    )
    if not ep:
        api_error(404, "ENDPOINT_NOT_FOUND", "Endpoint not found")
    return _build_endpoint_out(ep)


@router.patch("/api/endpoints/bulk",
              dependencies=[require_role("admin", "operator")])
def bulk_update_endpoints(body: BulkEndpointUpdate, request: Request,
                          db: Session = Depends(get_db)):
    updates = {}
    if body.ignored is not None:
        updates["ignored"] = body.ignored
    if not updates:
        api_error(400, "NO_FIELDS", "No fields to update")

    count = db.query(Endpoint).filter(
        Endpoint.id.in_(body.endpoint_ids)
    ).update(updates, synchronize_session="fetch")
    db.commit()
    log_audit(request, "bulk_update", "endpoint", "",
              {"endpoint_ids": body.endpoint_ids, "fields": list(updates.keys())})
    return {"updated": count}


@router.patch("/api/endpoints/{endpoint_id}",
              dependencies=[require_role("admin", "operator")])
def update_endpoint(endpoint_id: int, body: EndpointUpdate, request: Request,
                    db: Session = Depends(get_db)):
    ep = db.query(Endpoint).filter(Endpoint.id == endpoint_id).first()
    if not ep:
        api_error(404, "ENDPOINT_NOT_FOUND", "Endpoint not found")

    payload = body.model_dump(exclude_unset=True)
    if "ignored" in payload and payload["ignored"] is not None:
        ep.ignored = payload["ignored"]
    if "notes" in payload:
        ep.notes = payload["notes"]

    db.commit()
    db.refresh(ep)
    log_audit(request, "update", "endpoint", str(endpoint_id), {"fields": list(payload.keys())})
    return _build_endpoint_out(ep)


@router.delete("/api/endpoints/{endpoint_id}",
               dependencies=[require_role("admin")])
def delete_endpoint(endpoint_id: int, request: Request,
                    db: Session = Depends(get_db)):
    ep = db.query(Endpoint).filter(Endpoint.id == endpoint_id).first()
    if not ep:
        api_error(404, "ENDPOINT_NOT_FOUND", "Endpoint not found")

    db.delete(ep)
    db.commit()
    log_audit(request, "delete", "endpoint", str(endpoint_id), {})
    return {"deleted": True}
