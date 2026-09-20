/**
 * Tests for the map rack panel ordering: the pure split/sort helpers and the
 * RackDetail rendering of placed (U-sorted) vs unplaced (class sections)
 * devices.
 */
import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";
import RackDetail from "../components/map/RackDetail";
import { splitDevicesForRackPanel, uBadgeLabel } from "../components/map/rackPanelOrder";
import type { TopologyNode } from "../types";

function makeNode(partial: Partial<TopologyNode>): TopologyNode {
  return {
    id: 0,
    ip: "10.0.0.1",
    hostname: "sw",
    sys_name: "sw",
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
    ...partial,
  };
}

describe("splitDevicesForRackPanel", () => {
  it("sorts placed devices by U position descending (highest U first)", () => {
    const nodes = [
      makeNode({ id: 1, rack_u_position: 1 }),
      makeNode({ id: 2, rack_u_position: 12 }),
      makeNode({ id: 3, rack_u_position: 5 }),
    ];
    const { placed, unplaced } = splitDevicesForRackPanel(nodes);
    expect(placed.map(d => d.id)).toEqual([2, 3, 1]);
    expect(unplaced).toEqual([]);
  });

  it("keeps unplaced devices in their incoming order", () => {
    const nodes = [
      makeNode({ id: 7, rack_u_position: null }),
      makeNode({ id: 4 }),
      makeNode({ id: 9, rack_u_position: null }),
    ];
    const { placed, unplaced } = splitDevicesForRackPanel(nodes);
    expect(placed).toEqual([]);
    expect(unplaced.map(d => d.id)).toEqual([7, 4, 9]);
  });

  it("handles mixed input: placed sorted, unplaced order preserved", () => {
    const nodes = [
      makeNode({ id: 1, rack_u_position: 2 }),
      makeNode({ id: 2, rack_u_position: null }),
      makeNode({ id: 3, rack_u_position: 10 }),
      makeNode({ id: 4, rack_u_position: null }),
    ];
    const { placed, unplaced } = splitDevicesForRackPanel(nodes);
    expect(placed.map(d => d.id)).toEqual([3, 1]);
    expect(unplaced.map(d => d.id)).toEqual([2, 4]);
  });

  it("does not mutate the input array", () => {
    const nodes = [
      makeNode({ id: 1, rack_u_position: 2 }),
      makeNode({ id: 2, rack_u_position: 10 }),
    ];
    splitDevicesForRackPanel(nodes);
    expect(nodes.map(d => d.id)).toEqual([1, 2]);
  });
});

describe("uBadgeLabel", () => {
  it("returns null for unplaced devices", () => {
    expect(uBadgeLabel(makeNode({ id: 1, rack_u_position: null }))).toBeNull();
  });

  it("labels a single-U device", () => {
    expect(uBadgeLabel(makeNode({ id: 1, rack_u_position: 12 }))).toBe("U12");
  });

  it("labels a multi-U device as a range", () => {
    expect(uBadgeLabel(makeNode({ id: 1, rack_u_position: 12, u_height: 2 }))).toBe("U12-13");
  });
});

describe("RackDetail rack elevation ordering", () => {
  const mixedRack = {
    id: 1,
    label: "Rack A",
    location: "RZ-01",
    devices: [
      makeNode({ id: 1, ip: "10.0.0.1", sys_name: "sw-bottom", rack_id: 1, rack_u_position: 1, u_height: 2 }),
      makeNode({ id: 2, ip: "10.0.0.2", sys_name: "sw-top", rack_id: 1, rack_u_position: 5 }),
      makeNode({ id: 3, ip: "10.0.0.3", sys_name: "sw-unplaced", rack_id: 1, rack_u_position: null }),
    ],
  };

  it("renders placed devices U-descending above an Unplaced section", () => {
    const { container } = renderWithRouter(<RackDetail rack={mixedRack} />);

    expect(screen.getByText("Rack elevation (2)")).toBeTruthy();
    expect(screen.getByText("Unplaced (1)")).toBeTruthy();
    expect(screen.getByText("U5")).toBeTruthy();
    expect(screen.getByText("U1-2")).toBeTruthy();

    const link = screen.getByText("Place in rack elevation") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/racks");

    const text = container.textContent || "";
    const iTop = text.indexOf("sw-top");
    const iBottom = text.indexOf("sw-bottom");
    const iUnplacedHeader = text.indexOf("Unplaced (1)");
    const iUnplaced = text.indexOf("sw-unplaced");
    expect(iTop).toBeGreaterThanOrEqual(0);
    expect(iTop).toBeLessThan(iBottom); // highest U at the top of the panel
    expect(iBottom).toBeLessThan(iUnplacedHeader);
    expect(iUnplacedHeader).toBeLessThan(iUnplaced); // unplaced below the divider
  });

  it("shows no reorder arrows for placed devices in a fully placed rack", () => {
    const rack = { ...mixedRack, devices: mixedRack.devices.slice(0, 2) };
    renderWithRouter(<RackDetail rack={rack} />);

    expect(screen.getByText("Rack elevation (2)")).toBeTruthy();
    expect(screen.queryByText(/^Unplaced/)).toBeNull();
    expect(screen.queryByText("^")).toBeNull();
    expect(screen.queryByText("v")).toBeNull();
  });

  it("renders a rack with nothing placed exactly as class sections with arrows", () => {
    const rack = {
      ...mixedRack,
      devices: [
        makeNode({ id: 1, ip: "10.0.0.1", sys_name: "sw-a", rack_id: 1 }),
        makeNode({ id: 2, ip: "10.0.0.2", sys_name: "sw-b", rack_id: 1 }),
      ],
    };
    renderWithRouter(<RackDetail rack={rack} />);

    expect(screen.queryByText(/^Rack elevation/)).toBeNull();
    expect(screen.queryByText(/^Unplaced/)).toBeNull();
    // Unclassified devices fall into the "Other" class section with reorder arrows
    expect(screen.getByText("Other (2)")).toBeTruthy();
    expect(screen.getAllByText("^").length).toBeGreaterThan(0);
  });

  it("passes the U badge into the placed device card header", () => {
    renderWithRouter(<RackDetail rack={mixedRack} />);
    const topCard = screen.getByText("sw-top").closest(".bg-panel") as HTMLElement;
    expect(within(topCard).getByText("U5")).toBeTruthy();
  });
});
