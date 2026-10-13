/**
 * Pure tests for buildings/floors: floor resolution, active floor fallback,
 * floor-scoped graph builders and cross-floor portal derivation.
 */
import { describe, it, expect } from "vitest";
import type { Building, RackInfo, TopologyLink, TopologyNode } from "../types";
import {
  UNASSIGNED,
  createFloorScope,
  effectiveDeviceFloor,
  flattenFloors,
  floorDisplayLabel,
  parseFloorKey,
  resolveActiveFloor,
  summarizeFloors,
  viewportStorageKey,
} from "../features/topology/floors";
import {
  buildAggregatedLinks,
  buildEndpointIndex,
  buildMapRacks,
  buildOutsideNodes,
  buildPortals,
  makeEndpointFloor,
} from "../features/topology/graph";

function node(id: number, ip: string, extra: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id,
    ip,
    hostname: "",
    sys_name: `sw-${id}`,
    vendor: "generic",
    model: "",
    mac: "",
    rack_id: null,
    class_id: null,
    model_id: null,
    x: null,
    y: null,
    map_x: 0,
    map_y: 0,
    ignored: false,
    role: "",
    ports_per_row: 24,
    total_ports: 0,
    ports: [],
    floor_id: null,
    ...extra,
  } as TopologyNode;
}

function rack(id: number, floorId: number | null): RackInfo {
  return { id, label: `R${id}`, location: "", room: "", row_pos: null, col_pos: null, floor_id: floorId };
}

function link(id: number, a: string, b: string): TopologyLink {
  return {
    id,
    local_ip: a,
    local_port: `p${id}`,
    remote_ip: b,
    remote_port: `p${id}`,
    local_sys_name: "",
    remote_sys_name: "",
    speed_label: "10G",
  };
}

function floor(id: number, buildingId: number, label: string, sortOrder: number) {
  return {
    id,
    building_id: buildingId,
    label,
    sort_order: sortOrder,
    has_background: false,
    bg_version: 0,
    bg_opacity: 0.3,
    bg_scale: 1,
    bg_color: "#020817",
  };
}

const BUILDINGS: Building[] = [
  { id: 2, label: "Annex", description: null, sort_order: 1, floors: [floor(30, 2, "Basement", 0)] },
  {
    id: 1,
    label: "Main",
    description: null,
    sort_order: 0,
    floors: [floor(11, 1, "First", 1), floor(10, 1, "Ground", 0)],
  },
];

const NO_FILTER = { racks: null, classes: null };

describe("floor helpers", () => {
  it("flattens buildings and floors by sort_order", () => {
    expect(flattenFloors(BUILDINGS).map(e => e.floor.id)).toEqual([10, 11, 30]);
    expect(flattenFloors([])).toEqual([]);
  });

  it("parses floor keys from URL/localStorage values", () => {
    expect(parseFloorKey("12")).toBe(12);
    expect(parseFloorKey("unassigned")).toBe(UNASSIGNED);
    expect(parseFloorKey("abc")).toBeNull();
    expect(parseFloorKey(null)).toBeNull();
  });

  it("resolves the effective floor: rack floor wins for racked devices", () => {
    const racksById = new Map([[1, rack(1, 11)]]);
    expect(effectiveDeviceFloor(node(1, "a", { rack_id: 1, floor_id: 10 }), racksById)).toBe(11);
    expect(effectiveDeviceFloor(node(2, "b", { floor_id: 10 }), racksById)).toBe(10);
    expect(effectiveDeviceFloor(node(3, "c"), racksById)).toBeNull();
  });

  it("falls back to the first floor and only allows Unassigned when needed", () => {
    expect(resolveActiveFloor([], 10, true)).toBeNull();
    expect(resolveActiveFloor(BUILDINGS, 11, false)).toBe(11);
    expect(resolveActiveFloor(BUILDINGS, 999, false)).toBe(10);
    expect(resolveActiveFloor(BUILDINGS, null, false)).toBe(10);
    expect(resolveActiveFloor(BUILDINGS, UNASSIGNED, true)).toBe(UNASSIGNED);
    expect(resolveActiveFloor(BUILDINGS, UNASSIGNED, false)).toBe(10);
  });

  it("labels floors with a building prefix only across buildings", () => {
    expect(floorDisplayLabel(BUILDINGS, 11, 1)).toBe("First");
    expect(floorDisplayLabel(BUILDINGS, 30, 1)).toBe("Annex / Basement");
    expect(floorDisplayLabel(BUILDINGS, UNASSIGNED, 1)).toBe("Unassigned");
  });

  it("uses per-floor viewport keys and the legacy key without floors", () => {
    expect(viewportStorageKey(null)).toBe("net2map-zoom");
    expect(viewportStorageKey(10)).toBe("net2map-zoom:10");
    expect(viewportStorageKey(UNASSIGNED)).toBe("net2map-zoom:unassigned");
  });

  it("counts map-visible devices per floor including unassigned", () => {
    const classes = [{ id: 5, label: "AP", color: "", allow_outside_rack: false }];
    const nodes = [
      node(1, "a", { rack_id: 1 }),
      node(2, "b", { floor_id: 11 }),
      node(3, "c"),
      // Hidden by its class: not counted anywhere.
      node(4, "d", { class_id: 5 }),
    ];
    const summary = summarizeFloors(nodes, [rack(1, 10)], classes);
    expect(summary.counts.get(10)).toBe(1);
    expect(summary.counts.get(11)).toBe(1);
    expect(summary.unassigned).toBe(1);
  });
});

describe("floor-scoped graph", () => {
  const racks = [rack(1, 10), rack(2, 11)];
  const nodes = [
    node(1, "10.0.0.1", { rack_id: 1 }),
    node(2, "10.0.0.2", { rack_id: 2 }),
    node(3, "10.0.0.3", { floor_id: 10 }),
    node(4, "10.0.0.4"),
  ];

  it("only includes racks and outside devices of the active floor", () => {
    const scope = createFloorScope(10, racks);
    expect(buildMapRacks(nodes, racks, NO_FILTER, scope).map(r => r.id)).toEqual([1]);
    expect(buildOutsideNodes(nodes, [], NO_FILTER, scope).map(n => n.id)).toEqual([3]);
    expect(Object.keys(buildEndpointIndex(nodes, racks, [], scope)).sort()).toEqual(["10.0.0.1", "10.0.0.3"]);
  });

  it("shows unassigned devices on the Unassigned pseudo floor", () => {
    const scope = createFloorScope(UNASSIGNED, racks);
    expect(buildMapRacks(nodes, racks, NO_FILTER, scope)).toEqual([]);
    expect(buildOutsideNodes(nodes, [], NO_FILTER, scope).map(n => n.id)).toEqual([4]);
  });

  it("keeps everything without a scope (no floors defined)", () => {
    expect(buildMapRacks(nodes, racks, NO_FILTER).map(r => r.id)).toEqual([1, 2]);
    expect(buildOutsideNodes(nodes, [], NO_FILTER).map(n => n.id)).toEqual([3, 4]);
  });

  it("derives one portal per remote endpoint for cross-floor links", () => {
    const scope = createFloorScope(10, racks);
    const links = [
      link(1, "10.0.0.1", "10.0.0.2"), // rack 1 (floor 10) -> rack 2 (floor 11)
      link(2, "10.0.0.3", "10.0.0.2"), // outside 3 (floor 10) -> rack 2
      link(3, "10.0.0.1", "10.0.0.4"), // rack 1 -> unassigned device 4
      link(4, "10.0.0.1", "10.0.0.3"), // same floor: regular edge
    ];
    const index = buildEndpointIndex(nodes, racks, []);
    const visible = new Set(["1", "outside:3"]);
    const portals = buildPortals(links, index, visible, makeEndpointFloor(nodes, racks, scope), 10);
    expect(portals.map(p => [p.remote, p.remoteFloor])).toEqual([
      ["2", 11],
      ["outside:4", UNASSIGNED],
    ]);
    expect(portals[0].links.map(l => l.from)).toEqual(["1", "outside:3"]);
    expect(portals[0].links.every(l => l.to === "2")).toBe(true);
    // The same-floor link stays a regular aggregated edge.
    expect(buildAggregatedLinks(links, index, visible).map(l => l.key)).toEqual(["1|outside:3"]);
  });

  it("creates no portal for same-floor endpoints hidden by a filter", () => {
    const scope = createFloorScope(10, racks);
    const index = buildEndpointIndex(nodes, racks, []);
    const portals = buildPortals(
      [link(1, "10.0.0.1", "10.0.0.3")],
      index,
      new Set(["1"]),
      makeEndpointFloor(nodes, racks, scope),
      10,
    );
    expect(portals).toEqual([]);
  });
});
