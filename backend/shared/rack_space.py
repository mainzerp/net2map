"""Rack U-space occupancy rules shared by every rack placement check.

An object (placed device or rack item) occupies the U range
[rack_u_position, rack_u_position + u_height - 1] on its rack_side
("front" | "rear"); a full_depth object occupies that range on both sides.
Two objects conflict iff their U ranges overlap AND their occupied side sets
intersect.

The pure helpers work on ``RackSlot`` values; ``collect_rack_slots`` loads the
current occupancy of a rack from the database. ``database`` is imported lazily
like in the other shared modules.
"""
from dataclasses import dataclass
from typing import FrozenSet, Iterable, List, Optional, Sequence, Tuple

RACK_SIDES = ("front", "rear")
DEFAULT_RACK_SIDE = "front"


def occupied_sides(side: Optional[str], full_depth: bool) -> FrozenSet[str]:
    """Rack sides an object occupies."""
    if full_depth:
        return frozenset(RACK_SIDES)
    return frozenset({side if side in RACK_SIDES else DEFAULT_RACK_SIDE})


@dataclass(frozen=True)
class RackSlot:
    """One occupied U range on a rack."""
    position: int
    height: int
    side: str = DEFAULT_RACK_SIDE
    full_depth: bool = False
    kind: str = "device"          # "device" | "rack_item"
    obj_id: Optional[int] = None

    @property
    def top(self) -> int:
        return self.position + max(self.height, 1) - 1

    @property
    def sides(self) -> FrozenSet[str]:
        return occupied_sides(self.side, self.full_depth)

    @property
    def label(self) -> str:
        noun = "rack item" if self.kind == "rack_item" else "device"
        return f"{noun} {self.obj_id}"


def slots_conflict(a: RackSlot, b: RackSlot) -> bool:
    """True iff the U ranges overlap and the occupied side sets intersect."""
    if a.position > b.top or b.position > a.top:
        return False
    return bool(a.sides & b.sides)


def find_conflict(slot: RackSlot, others: Iterable[RackSlot]) -> Optional[RackSlot]:
    """First slot in ``others`` that conflicts with ``slot`` (same object excluded)."""
    for other in others:
        if other.kind == slot.kind and other.obj_id is not None and other.obj_id == slot.obj_id:
            continue
        if slots_conflict(slot, other):
            return other
    return None


def find_pairwise_conflict(slots: Sequence[RackSlot]) -> Optional[Tuple[RackSlot, RackSlot]]:
    """First conflicting pair within ``slots`` (ordered by position), or None."""
    ordered = sorted(slots, key=lambda s: (s.position, s.top))
    for i, a in enumerate(ordered):
        for b in ordered[i + 1:]:
            if b.position > a.top:
                break
            if slots_conflict(a, b):
                return a, b
    return None


def conflict_details(*slots: RackSlot) -> list:
    """Structured error details naming the conflicting objects."""
    return [{
        "device_ids": [s.obj_id for s in slots if s.kind == "device"],
        "rack_item_ids": [s.obj_id for s in slots if s.kind == "rack_item"],
    }]


def device_slot(device, *, position=None, height=None, side=None, full_depth=None) -> RackSlot:
    """Slot of a device; keyword values override the stored placement."""
    return RackSlot(
        position=position if position is not None else device.rack_u_position,
        height=height if height is not None else (device.u_height or 1),
        side=side if side is not None else (device.rack_side or DEFAULT_RACK_SIDE),
        full_depth=full_depth if full_depth is not None else bool(device.full_depth),
        kind="device",
        obj_id=device.id,
    )


def item_slot(item, *, position=None, height=None, side=None, full_depth=None) -> RackSlot:
    """Slot of a rack item; keyword values override the stored placement."""
    return RackSlot(
        position=position if position is not None else item.rack_u_position,
        height=height if height is not None else (item.u_height or 1),
        side=side if side is not None else (item.rack_side or DEFAULT_RACK_SIDE),
        full_depth=full_depth if full_depth is not None else bool(item.full_depth),
        kind="rack_item",
        obj_id=item.id,
    )


def collect_rack_slots(
    db,
    rack_id: int,
    *,
    exclude_device_ids: Iterable[int] = (),
    exclude_item_ids: Iterable[int] = (),
    include_devices: bool = True,
    include_items: bool = True,
) -> List[RackSlot]:
    """Slots of the placed devices and rack items of a rack."""
    from database import Device, RackItem

    excluded_devices = set(exclude_device_ids)
    excluded_items = set(exclude_item_ids)
    slots: List[RackSlot] = []
    if include_devices:
        devices = db.query(Device).filter(Device.rack_id == rack_id, Device.rack_u_position.isnot(None)).all()
        slots.extend(device_slot(d) for d in devices if d.id not in excluded_devices)
    if include_items:
        items = db.query(RackItem).filter(RackItem.rack_id == rack_id).all()
        slots.extend(item_slot(i) for i in items if i.id not in excluded_items)
    return slots


def carry_rack_floors(db, device_ids: Iterable[int]) -> None:
    """Give racked devices their rack's floor before they leave the rack.

    A racked device shows on its rack's floor; its own floor_id is ignored.
    Without this, removing it from the rack (single or bulk unassign, rack
    deletion) dropped it onto its stale own floor or "Unassigned". Devices
    whose rack has no floor keep their floor_id. Call before clearing
    rack_id; the caller commits.
    """
    from database import Device, Rack

    ids = list(device_ids)
    if not ids:
        return
    rows = (
        db.query(Device.id, Rack.floor_id)
        .join(Rack, Device.rack_id == Rack.id)
        .filter(Device.id.in_(ids), Rack.floor_id.isnot(None))
        .all()
    )
    by_floor: dict = {}
    for device_id, floor_id in rows:
        by_floor.setdefault(floor_id, []).append(device_id)
    for floor_id, floor_device_ids in by_floor.items():
        db.query(Device).filter(Device.id.in_(floor_device_ids)).update(
            {Device.floor_id: floor_id}, synchronize_session="fetch",
        )
