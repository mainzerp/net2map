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
