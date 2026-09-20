/**
 * Tests for the React Flow topology canvas: rack nodes render for racked
 * devices, unracked devices render as device nodes, the toolbar search finds
 * devices, and filter chips hide racks from the canvas.
 */
import React from "react";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TopologyCanvas from "../features/topology/TopologyCanvas";
import type { TopologyNode, RackInfo } from "../types";

// ── jsdom shims for @xyflow/react ────────────────────────────────────────────
beforeAll(() => {
  // xyflow hides nodes/edges until a ResizeObserver reports dimensions; the
  // mock fires one (zero-size) measurement per observed element so the flow
  // becomes visible and edges render under jsdom.
  class ResizeObserverMock {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      const entry = {
        target,
        contentRect: target.getBoundingClientRect(),
        borderBoxSize: [{ inlineSize: 0, blockSize: 0 }],
        contentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
        devicePixelContentBoxSize: [],
      } as unknown as ResizeObserverEntry;
      Promise.resolve().then(() =>
        this.callback([entry], this as unknown as ResizeObserver),
      );
    }
    unobserve() {}
    disconnect() {}
  }
  // @ts-expect-error test shim
  global.ResizeObserver = global.ResizeObserver || ResizeObserverMock;

  // xyflow reads the zoom scale out of DOMMatrixReadOnly transforms
  class DOMMatrixReadOnlyMock {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  // @ts-expect-error test shim
  global.DOMMatrixReadOnly = global.DOMMatrixReadOnly || DOMMatrixReadOnlyMock;

  // jsdom reports all-zero boxes; xyflow sizes nodes from offsetWidth/
  // offsetHeight and getBoundingClientRect, so honor inline width/height.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return parseFloat(this.style?.width || "0") || 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return parseFloat(this.style?.height || "0") || 0;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const width = parseFloat(el.style?.width || "0") || 0;
    const height = parseFloat(el.style?.height || "0") || 0;
    return {
      width,
      height,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

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

function makeRack(overrides: Partial<RackInfo>): RackInfo {
  return {
    id: 1,
    label: "Rack",
    location: "",
    room: "",
    row_pos: null,
    col_pos: null,
    ...overrides,
  };
}

const defaultProps = {
  links: [],
  managedRacks: [] as RackInfo[],
  switchClasses: [],
  filters: { racks: null, classes: null },
  onFilterChange: () => {},
  selectedRackId: undefined,
  selectedOutsideId: null,
  onSelectRack: () => {},
  onSelectOutside: () => {},
  onSearchSelect: () => {},
  onRackPositionChange: () => {},
  onDevicePositionChange: () => {},
  onAutoLayout: () => {},
  selectedLink: null,
  rackPairColorMap: {},
  mapBgUrl: null,
  mapBgOpacity: 0.3,
  mapBgScale: 1,
  mapBgColor: "var(--surface)",
  stats: { switches: 0, fast: 0, gig: 0 },
  updatedAt: null,
};

function rackNodeTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".react-flow__node-rack")).map(
    el => el.textContent || "",
  );
}

describe("TopologyCanvas", () => {
  it("renders a rack node for devices assigned to a rack", () => {
    const nodes = [
      makeNode({ id: 7, ip: "192.168.120.220", sys_name: "SW-Keller", rack_id: 1, class_id: 1, map_x: 430, map_y: 318 }),
      makeNode({ id: 15, ip: "192.168.120.254", sys_name: "OPNsense", rack_id: 1, class_id: 2, map_x: 330, map_y: 483 }),
    ];
    const managedRacks = [makeRack({ id: 1, label: "Keller" })];
    const { container } = render(<TopologyCanvas {...defaultProps} nodes={nodes} managedRacks={managedRacks} />);
    const rackTexts = rackNodeTexts(container);
    expect(rackTexts.length).toBe(1);
    expect(rackTexts[0]).toContain("Keller");
  });

  it("renders devices without rack and class as outside device nodes", () => {
    const nodes = [
      makeNode({ id: 4, ip: "192.168.120.219", sys_name: "AP-Terasse", map_x: 620, map_y: 105 }),
    ];
    render(<TopologyCanvas {...defaultProps} nodes={nodes} />);
    expect(screen.getByText("AP-Terasse")).toBeTruthy();
    expect(screen.getByText("192.168.120.219")).toBeTruthy();
  });

  it("renders outside nodes with a class only when allow_outside_rack is set", () => {
    const classes = [
      { id: 3, label: "AP", color: "var(--accent)", allow_outside_rack: false },
      { id: 4, label: "IoT", color: "var(--accent)", allow_outside_rack: true },
    ];
    const nodes = [
      makeNode({ id: 1, ip: "10.0.0.1", sys_name: "hidden-ap", class_id: 3 }),
      makeNode({ id: 2, ip: "10.0.0.2", sys_name: "visible-iot", class_id: 4 }),
    ];
    render(<TopologyCanvas {...defaultProps} nodes={nodes} switchClasses={classes} />);
    expect(screen.queryByText("hidden-ap")).toBeNull();
    expect(screen.getByText("visible-iot")).toBeTruthy();
  });

  it("renders an aggregated edge badge for a link between two racks", async () => {
    const nodes = [
      makeNode({ id: 7, ip: "10.0.1.1", sys_name: "sw-a", rack_id: 1, map_x: 300, map_y: 200 }),
      makeNode({ id: 8, ip: "10.0.2.1", sys_name: "sw-b", rack_id: 2, map_x: 600, map_y: 200 }),
    ];
    const managedRacks = [makeRack({ id: 1, label: "R1" }), makeRack({ id: 2, label: "R2" })];
    const links = [{
      id: 1,
      local_ip: "10.0.1.1", local_port: "1/1/1",
      remote_ip: "10.0.2.1", remote_port: "1/1/1",
      local_sys_name: "sw-a", remote_sys_name: "sw-b",
      speed_label: "10G",
    }];
    render(
      <TopologyCanvas {...defaultProps} nodes={nodes} managedRacks={managedRacks} links={links} />,
    );
    // Edges render only after the (mocked) ResizeObserver reports node sizes.
    expect(await screen.findByText("10G")).toBeTruthy();
  });

  it("toolbar search finds a device and reports the selection", async () => {
    const user = userEvent.setup();
    const onSearchSelect = vi.fn();
    const nodes = [
      makeNode({ id: 7, ip: "192.168.120.220", sys_name: "SW-Keller", rack_id: 1, map_x: 430, map_y: 318 }),
    ];
    const managedRacks = [makeRack({ id: 1, label: "Keller" })];
    render(
      <TopologyCanvas {...defaultProps} nodes={nodes} managedRacks={managedRacks} onSearchSelect={onSearchSelect} />,
    );
    const input = screen.getByLabelText("Search device");
    await user.type(input, "keller");
    const suggestion = await screen.findByText("SW-Keller");
    await user.click(suggestion);
    expect(onSearchSelect).toHaveBeenCalledTimes(1);
    expect(onSearchSelect).toHaveBeenCalledWith(expect.objectContaining({ sys_name: "SW-Keller" }));
  });

  it("rack filter chips hide racks from the canvas", () => {
    const nodes = [
      makeNode({ id: 7, ip: "10.0.1.1", sys_name: "sw-a", rack_id: 1, map_x: 300, map_y: 200 }),
      makeNode({ id: 8, ip: "10.0.2.1", sys_name: "sw-b", rack_id: 2, map_x: 600, map_y: 200 }),
    ];
    const managedRacks = [makeRack({ id: 1, label: "R1" }), makeRack({ id: 2, label: "R2" })];
    const filters = { racks: new Set<number>([2]), classes: null };
    const { container } = render(
      <TopologyCanvas {...defaultProps} nodes={nodes} managedRacks={managedRacks} filters={filters} />,
    );
    const rackTexts = rackNodeTexts(container);
    expect(rackTexts.length).toBe(1);
    expect(rackTexts[0]).toContain("R2");
  });
});
