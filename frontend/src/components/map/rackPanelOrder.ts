// ── Rack panel ordering (pure, unit-tested) ─────────────────────────────────
// The map's rack panel mirrors the physical rack elevation: devices with a
// rack_u_position are shown as one continuous sequence sorted by U position
// descending (highest U at the top, matching the /racks elevation view where
// U1 sits at the bottom). Devices without a position keep the manual
// class-section ordering and are rendered below.

import type { TopologyNode } from "../../types";
import { deviceUHeight } from "../../features/racks/rackLayout";

export interface RackPanelSplit {
  placed: TopologyNode[];
  unplaced: TopologyNode[];
}

export function splitDevicesForRackPanel(devices: TopologyNode[]): RackPanelSplit {
  const placed: TopologyNode[] = [];
  const unplaced: TopologyNode[] = [];
  for (const d of devices) {
    if (d.rack_u_position != null) placed.push(d);
    else unplaced.push(d);
  }
  placed.sort((a, b) => (b.rack_u_position as number) - (a.rack_u_position as number) || a.id - b.id);
  return { placed, unplaced };
}

// Short U-range label for a placed device, e.g. "U12" or "U12-13".
export function uBadgeLabel(device: TopologyNode): string | null {
  if (device.rack_u_position == null) return null;
  const pos = device.rack_u_position;
  const height = deviceUHeight(device);
  return height > 1 ? `U${pos}-${pos + height - 1}` : `U${pos}`;
}
