/**
 * Tests for the rack elevation view: U scale rendering, placed-device row
 * positions, the unassigned tray, and the pure layout-payload functions.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithRouter } from "./test-utils";

const mockApiGet = vi.fn();
const mockApiPatch = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    del: vi.fn(),
    invalidate: vi.fn(),
  },
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  getStoredUser: () => ({ username: "admin", role: "admin" }),
  getStoredToken: () => "token",
  normPort: (s: string) => (s || "").trim().toLowerCase(),
  API: "",
}));

// Must import after mocks are set up
import RacksPage from "../pages/RacksPage";
import {
  CLICK_MOVE_THRESHOLD_PX,
  U_PX,
  buildLayoutEntries,
  isClickGesture,
  computeDropTarget,
  placementsFromNodes,
  rowFromTop,
  type Placement,
} from "../features/racks/rackLayout";
import type { TopologyData, TopologyNode } from "../types";

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

const TOPOLOGY: TopologyData = {
  nodes: [
    makeNode({ id: 1, ip: "10.0.0.1", sys_name: "sw-bottom", rack_id: 1, rack_u_position: 1, u_height: 2 }),
    makeNode({ id: 2, ip: "10.0.0.2", sys_name: "sw-mid", rack_id: 1, rack_u_position: 5 }),
    makeNode({ id: 3, ip: "10.0.0.3", sys_name: "sw-unplaced", rack_id: 1, rack_u_position: null }),
    makeNode({ id: 4, ip: "10.0.0.4", sys_name: "sw-norack", rack_id: null, rack_u_position: null }),
  ],
  links: [],
  racks: [
    { id: 1, label: "Rack A", location: "", room: "RZ-01", height_u: 12, row_pos: null, col_pos: null },
  ],
  classes: [],
  models: [],
};

describe("RacksPage / RackElevation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") return Promise.resolve(structuredClone(TOPOLOGY));
      return Promise.resolve([]);
    });
    mockApiPatch.mockResolvedValue({});
  });

  it("renders the rack header, U scale and occupancy", async () => {
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });

    await screen.findByTestId("rack-body");
    expect(screen.getByText("Rack A")).toBeTruthy();
    expect(screen.getByText("RZ-01")).toBeTruthy();
    expect(screen.getByText("12U")).toBeTruthy();
    // used = 2 (device 1) + 1 (device 2, default u_height) = 3
    expect(screen.getByText("3/12 U used - 9 U free")).toBeTruthy();
    // U numbers appear on both scale columns
    expect(screen.getAllByText("12").length).toBe(2);
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(2);
  });

  it("renders placed devices at the correct rows (U1 at the bottom)", async () => {
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });

    const fp1 = await screen.findByTestId("faceplate-1");
    const fp2 = await screen.findByTestId("faceplate-2");

    // Device 1: pos 1, height 2 in a 12U rack -> row 10 from the top
    const row1 = rowFromTop(12, 1, 2);
    expect(row1).toBe(10);
    expect((fp1.parentElement as HTMLElement).style.top).toBe(`${row1 * U_PX + 1}px`);
    expect((fp1.parentElement as HTMLElement).style.height).toBe(`${2 * U_PX - 2}px`);

    // Device 2: pos 5, default height 1 -> row 7 from the top
    const row2 = rowFromTop(12, 5, 1);
    expect(row2).toBe(7);
    expect((fp2.parentElement as HTMLElement).style.top).toBe(`${row2 * U_PX + 1}px`);

    expect(within(fp1).getByText("sw-bottom")).toBeTruthy();
    expect(within(fp2).getByText("sw-mid")).toBeTruthy();
  });

  it("lists unplaced and rack-less devices in the tray, not in the rack", async () => {
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });

    await screen.findByTestId("rack-body");
    expect(screen.getByTestId("tray-item-3")).toBeTruthy();
    expect(screen.getByTestId("tray-item-4")).toBeTruthy();
    expect(screen.getByText("Unplaced in this rack (1)")).toBeTruthy();
    expect(screen.getByText("No rack assigned (1)")).toBeTruthy();
    expect(screen.queryByTestId("faceplate-3")).toBeNull();
    expect(screen.queryByTestId("faceplate-4")).toBeNull();
  });

  it("draws rails with three mounting holes per U and blanking plates", async () => {
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    const body = await screen.findByTestId("rack-body");
    for (const side of ["left", "right"]) {
      const rail = screen.getByTestId(`rack-rail-${side}`);
      expect(rail.querySelectorAll(".rack-rail-hole")).toHaveLength(12 * 3);
    }
    expect(body.querySelectorAll(".rack-blank")).toHaveLength(12);
  });

  it("renders stylized port tiles with status attributes for up and down ports", async () => {
    const ports = [
      ...Array.from({ length: 24 }, (_, i) => ({
        id: i + 1,
        port_id: String(i + 1),
        name: String(i + 1),
        if_index: i + 1,
        // Odd ports up at 1G, even ports down; port 3 has endpoints.
        oper_status: i % 2 === 0 ? 1 : 2,
        speed: 0,
        speed_mbps: i % 2 === 0 ? 1000 : 0,
        vlan: 10,
        tagged_vlans: [],
        poe_status: null,
        endpoint_count: i === 2 ? 2 : 0,
      })),
      {
        id: 25, port_id: "25", name: "sfp1", if_index: 25, oper_status: 1, speed: 0,
        speed_mbps: 10000, vlan: null, tagged_vlans: [], poe_status: null, endpoint_count: 0,
      },
      {
        id: 26, port_id: "26", name: "sfp2", if_index: 26, oper_status: 2, speed: 0,
        speed_mbps: 0, vlan: null, tagged_vlans: [], poe_status: null, endpoint_count: 0,
      },
    ];
    const topo = structuredClone(TOPOLOGY);
    topo.nodes[1] = { ...topo.nodes[1], ports, ping_status: "online" };
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") return Promise.resolve(structuredClone(topo));
      return Promise.resolve([]);
    });

    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    const fp = await screen.findByTestId("faceplate-2");

    const block = within(fp).getByTestId("port-block");
    expect(block.getAttribute("data-mode")).toBe("two-row");

    // One tile per port: no separate socket well or inner LED element.
    const tiles = within(fp).getAllByTestId("port-tile");
    expect(tiles).toHaveLength(26);
    const up = tiles.filter((t) => t.getAttribute("data-status") === "up");
    const down = tiles.filter((t) => t.getAttribute("data-status") === "down");
    expect(up).toHaveLength(13);
    expect(down).toHaveLength(13);
    for (const tile of up) {
      // Filled in the speed color.
      expect(tile.className).toContain("rack-tile-up");
      expect(tile.style.backgroundColor).not.toBe("");
      expect(tile.style.getPropertyValue("--tile-color")).not.toBe("");
    }
    for (const tile of down) {
      // Hollow tile: no inline fill color.
      expect(tile.className).toContain("rack-tile-down");
      expect(tile.style.backgroundColor).toBe("");
    }

    // Endpoint presence marker only on port 3 (top row, second tile).
    const markers = within(fp).getAllByTestId("port-endpoint-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0].parentElement).toBe(tiles[1]);
    expect(tiles[1].getAttribute("title")).toBe("3 - up - 1G - VLAN 10 - 2 endpoints");

    // SFP ports are grouped at the right end with wider tiles.
    const uplinks = within(fp).getByTestId("uplink-group");
    const uplinkTiles = within(uplinks).getAllByTestId("port-tile");
    expect(uplinkTiles).toHaveLength(2);
    for (const t of uplinkTiles) {
      expect(t.getAttribute("data-uplink")).toBe("1");
      expect(t.className).toContain("rack-tile-uplink");
    }
    const access = within(fp).getByTestId("access-group");
    for (const t of within(access).getAllByTestId("port-tile")) {
      expect(t.getAttribute("data-uplink")).toBe("0");
      expect(t.className).not.toContain("rack-tile-uplink");
    }

    // Online status LED.
    expect(within(fp).getByTestId("device-status-led").getAttribute("data-status")).toBe("up");
  });

  it("renders a port legend under the rack using the same tile style", async () => {
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    await screen.findByTestId("rack-body");
    const legend = screen.getByTestId("rack-port-legend");
    for (const label of ["<1G", "1G", "10G", "25G+", "down", "endpoints", "uplink"]) {
      expect(within(legend).getByText(label)).toBeTruthy();
    }
    expect(legend.querySelectorAll(".rack-tile-up")).toHaveLength(6);
    expect(legend.querySelectorAll(".rack-tile-down")).toHaveLength(1);
    expect(legend.querySelectorAll(".rack-tile-uplink")).toHaveLength(1);
    expect(within(legend).getAllByTestId("port-endpoint-marker")).toHaveLength(1);
  });

  it("renders compact tiles for devices with more than 96 ports", async () => {
    const ports = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1, port_id: String(i + 1), name: String(i + 1), if_index: i + 1,
      oper_status: 1, speed: 0, speed_mbps: 1000, vlan: null, tagged_vlans: [],
      poe_status: null, endpoint_count: 0,
    }));
    const topo = structuredClone(TOPOLOGY);
    topo.nodes[1] = { ...topo.nodes[1], ports };
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") return Promise.resolve(structuredClone(topo));
      return Promise.resolve([]);
    });

    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    const fp = await screen.findByTestId("faceplate-2");
    expect(within(fp).getByTestId("port-block").getAttribute("data-mode")).toBe("compact");
    const tiles = within(fp).getAllByTestId("port-tile");
    expect(tiles).toHaveLength(100);
    for (const t of tiles) expect(t.className).toContain("rack-tile-compact");
    expect(within(fp).queryByTestId("uplink-group")).toBeNull();
    expect(within(fp).queryByTestId("access-group")).toBeNull();
  });
});

describe("RackElevation faceplate click vs drag", () => {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location">{decodeURIComponent(location.search)}</div>;
  }

  function renderRacks() {
    return renderWithRouter(
      <>
        <RacksPage />
        <LocationProbe />
      </>,
      { route: "/racks?rack=1" },
    );
  }

  // jsdom has no PointerEvent; without it fireEvent.pointer* builds a plain
  // Event that drops button/clientX/clientY. A MouseEvent subclass is enough.
  beforeAll(() => {
    if (typeof window.PointerEvent === "undefined") {
      class PointerEventPolyfill extends MouseEvent {
        constructor(type: string, init?: PointerEventInit) {
          super(type, init);
        }
      }
      vi.stubGlobal("PointerEvent", PointerEventPolyfill);
    }
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") return Promise.resolve(structuredClone(TOPOLOGY));
      return Promise.resolve([]);
    });
    mockApiPatch.mockResolvedValue({});
  });

  it("opens the inspector when the pointer is released without moving", async () => {
    renderRacks();
    const fp = await screen.findByTestId("faceplate-2");

    fireEvent.pointerDown(fp, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(window, { button: 0, clientX: 102, clientY: 101 });

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("?rack=1&inspect=device:2"),
    );
    expect(mockApiPatch).not.toHaveBeenCalled();
  });

  it("does not open the inspector when the pointer moved past the threshold", async () => {
    renderRacks();
    const fp = await screen.findByTestId("faceplate-2");

    fireEvent.pointerDown(fp, { button: 0, clientX: 100, clientY: 100 });
    // The drag started: the source faceplate is dimmed.
    expect(fp.className).toContain("opacity-40");
    fireEvent.pointerMove(window, { clientX: 100, clientY: 140 });
    fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 140 });

    expect(screen.getByTestId("location").textContent).toBe("?rack=1");
    // The drag ended: the faceplate is no longer dimmed.
    expect(fp.className).not.toContain("opacity-40");
  });

  it("opens the inspector with Enter on a focused faceplate", async () => {
    renderRacks();
    const fp = await screen.findByTestId("faceplate-1");
    expect(fp.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(fp, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("?rack=1&inspect=device:1"),
    );
  });
});

describe("isClickGesture", () => {
  it("treats movement below the threshold as a click", () => {
    expect(CLICK_MOVE_THRESHOLD_PX).toBe(4);
    expect(isClickGesture({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(true);
    expect(isClickGesture({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(true); // ~2.8px
    expect(isClickGesture({ x: 0, y: 0 }, { x: 3.9, y: 0 })).toBe(true);
  });

  it("treats movement at or above the threshold as a drag", () => {
    expect(isClickGesture({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(false);
    expect(isClickGesture({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false); // ~4.2px
    expect(isClickGesture({ x: 0, y: 0 }, { x: 0, y: 40 })).toBe(false);
    expect(isClickGesture({ x: 0, y: 0 }, { x: 5, y: 0 }, 10)).toBe(true);
  });
});

describe("rackLayout pure functions", () => {
  const placements: Placement[] = [
    { deviceId: 1, pos: 1, uHeight: 2 }, // occupies U1-U2
    { deviceId: 2, pos: 5, uHeight: 1 }, // occupies U5
  ];

  it("buildLayoutEntries produces a sorted layout payload", () => {
    expect(buildLayoutEntries(placements)).toEqual([
      { device_id: 1, rack_u_position: 1, u_height: 2 },
      { device_id: 2, rack_u_position: 5, u_height: 1 },
    ]);
  });

  it("placementsFromNodes picks up only positioned devices of the rack", () => {
    const result = placementsFromNodes(TOPOLOGY.nodes, 1, 12);
    expect(result).toEqual([
      { deviceId: 1, pos: 1, uHeight: 2 },
      { deviceId: 2, pos: 5, uHeight: 1 }, // undefined u_height defaults to 1
    ]);
  });

  it("placementsFromNodes clamps oversize heights and drops out-of-range positions", () => {
    const nodes = [
      makeNode({ id: 5, rack_id: 1, rack_u_position: 1, u_height: 48 }), // clamped to the 12U rack
      makeNode({ id: 6, rack_id: 1, rack_u_position: 20 }), // starts above the rack
      makeNode({ id: 7, rack_id: 1, rack_u_position: 0 }), // below U1
      makeNode({ id: 8, rack_id: 1, rack_u_position: -3 }), // negative
      makeNode({ id: 9, rack_id: 1, rack_u_position: 11, u_height: 2 }), // 11-12 fits exactly
      makeNode({ id: 10, rack_id: 1, rack_u_position: 12, u_height: 2 }), // 12-13 exceeds the top
    ];
    expect(placementsFromNodes(nodes, 1, 12)).toEqual([
      { deviceId: 5, pos: 1, uHeight: 12 },
      { deviceId: 9, pos: 11, uHeight: 2 },
    ]);
  });

  it("computeDropTarget snaps a row to a valid free position", () => {
    // Row 7 from the top in a 12U rack, height 1 -> pos 5 is taken, row 8 -> pos 4 is free
    const target = computeDropTarget(placements, 3, 8, 1, 12);
    expect(target.pos).toBe(4);
    expect(target.valid).toBe(true);
  });

  it("computeDropTarget flags overlaps with other devices", () => {
    // Row 10 from the top, height 2 -> pos 1, overlapping device 1 (U1-U2)
    const target = computeDropTarget(placements, 3, 10, 2, 12);
    expect(target.pos).toBe(1);
    expect(target.valid).toBe(false);
  });

  it("computeDropTarget ignores the dragged device's own placement", () => {
    // Device 1 dropped back onto its own range stays valid
    const target = computeDropTarget(placements, 1, 10, 2, 12);
    expect(target.pos).toBe(1);
    expect(target.valid).toBe(true);
  });

  it("computeDropTarget flags out-of-range drops", () => {
    // Row 12 is below the rack body: pos 0 is out of range
    const below = computeDropTarget(placements, 3, 12, 1, 12);
    expect(below.pos).toBe(0);
    expect(below.valid).toBe(false);
    // Row -1 is above the rack body: pos 13 exceeds heightU
    const above = computeDropTarget(placements, 3, -1, 1, 12);
    expect(above.pos).toBe(13);
    expect(above.valid).toBe(false);
  });
});
