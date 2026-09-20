/**
 * Tests for TopologyMap rendering: racked devices render as rack boxes,
 * unassigned devices (no rack, no class) render as outside nodes.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TopologyMap from "../components/map/TopologyMap";
import type { TopologyNode } from "../types";

function makeNode(overrides: Partial<TopologyNode>): TopologyNode {
  return {
    id: 1,
    ip: "10.0.0.1",
    hostname: "",
    sys_name: "sw-1",
    vendor: "generic",
    model: "",
    mac: "",
    rack_id: null,
    class_id: null,
    model_id: null,
    x: null,
    y: null,
    map_x: 100,
    map_y: 100,
    ignored: false,
    role: "",
    ports_per_row: 24,
    total_ports: 24,
    ports: [],
    ...overrides,
  } as TopologyNode;
}

const defaultProps = {
  links: [],
  switchClasses: [],
  filters: { racks: null, classes: null },
  onSelectRack: () => {},
  selectedRackId: undefined,
  selectedOutsideId: null,
  centerRackId: null,
  onPositionChange: () => {},
  mapBgUrl: null,
  mapBgOpacity: 0.3,
  mapBgScale: 1,
  mapBgNat: null,
  mapBgColor: "#020817",
  rackPairColorMap: {},
  selectedLink: null,
};

describe("TopologyMap", () => {
  it("renders a rack box for devices assigned to a rack", () => {
    const nodes = [
      makeNode({ id: 7, ip: "192.168.120.220", sys_name: "SW-Keller", rack_id: 1, class_id: 1, map_x: 430, map_y: 318 }),
      makeNode({ id: 15, ip: "192.168.120.254", sys_name: "OPNsense", rack_id: 1, class_id: 2, map_x: 330, map_y: 483 }),
    ];
    const managedRacks = [{ id: 1, label: "Keller", room: "", map_x: 100, map_y: 100 }];
    render(<TopologyMap {...defaultProps} nodes={nodes} managedRacks={managedRacks} />);
    expect(screen.getByText("Keller")).toBeTruthy();
  });

  it("renders devices without rack and class as outside nodes", () => {
    const nodes = [
      makeNode({ id: 4, ip: "192.168.120.219", sys_name: "AP-Terasse", map_x: 620, map_y: 105 }),
    ];
    render(<TopologyMap {...defaultProps} nodes={nodes} managedRacks={[]} />);
    expect(screen.getByText("AP-Terasse")).toBeTruthy();
    expect(screen.getByText("192.168.120.219")).toBeTruthy();
  });

  it("renders outside nodes with a class only when allow_outside_rack is set", () => {
    const classes = [
      { id: 3, label: "AP", color: "#fff", allow_outside_rack: false },
      { id: 4, label: "IoT", color: "#fff", allow_outside_rack: true },
    ];
    const nodes = [
      makeNode({ id: 1, ip: "10.0.0.1", sys_name: "hidden-ap", class_id: 3 }),
      makeNode({ id: 2, ip: "10.0.0.2", sys_name: "visible-iot", class_id: 4 }),
    ];
    render(<TopologyMap {...defaultProps} nodes={nodes} managedRacks={[]} switchClasses={classes} />);
    expect(screen.queryByText("hidden-ap")).toBeNull();
    expect(screen.getByText("visible-iot")).toBeTruthy();
  });
});
