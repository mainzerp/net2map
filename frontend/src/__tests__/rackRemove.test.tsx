/**
 * Tests for taking a device out of a rack in the rack elevation view: the
 * faceplate / tray "Remove from rack" action, its absence in read-only mode,
 * and dragging a placed faceplate onto the tray.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

const mockApiGet = vi.fn();
const mockApiPatch = vi.fn();
let mockRole = "admin";

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
  getStoredUser: () => ({ username: "user", role: mockRole }),
  getStoredToken: () => "token",
  normPort: (s: string) => (s || "").trim().toLowerCase(),
  API: "",
}));

// Must import after mocks are set up
import RacksPage from "../pages/RacksPage";
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

function renderRacks() {
  return renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
}

function topologyFetches(): number {
  return mockApiGet.mock.calls.filter(([path]) => path === "/api/topology").length;
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
  mockRole = "admin";
  mockApiGet.mockImplementation((path: string) => {
    if (path === "/api/topology") return Promise.resolve(structuredClone(TOPOLOGY));
    return Promise.resolve([]);
  });
  mockApiPatch.mockResolvedValue({});
});

describe("Remove from rack action", () => {
  it("removes a placed device via the faceplate button and refetches the topology", async () => {
    renderRacks();
    await screen.findByTestId("faceplate-2");
    const before = topologyFetches();

    fireEvent.click(screen.getByRole("button", { name: "Remove sw-mid from rack" }));

    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith("/api/topology/devices/2/meta", {
        rack_id: null,
        rack_u_position: null,
      }),
    );
    expect(mockApiPatch).toHaveBeenCalledTimes(1);
    // The faceplate button never opens the inspector or starts a layout move.
    expect(mockApiPatch.mock.calls.some(([path]) => String(path).startsWith("/api/racks/"))).toBe(false);
    await waitFor(() => expect(topologyFetches()).toBeGreaterThan(before));
  });

  it("does not start a drag when the remove button is pressed", async () => {
    renderRacks();
    const fp = await screen.findByTestId("faceplate-2");
    const button = screen.getByTestId("remove-from-rack-2");

    fireEvent.pointerDown(button, { button: 0, clientX: 100, clientY: 100 });
    expect(fp.className).not.toContain("opacity-40");
    expect(screen.getByTestId("rack-tray").getAttribute("data-drop-active")).toBe("0");
  });

  it("removes a device assigned to the rack without a position from the tray", async () => {
    renderRacks();
    await screen.findByTestId("tray-item-3");

    fireEvent.click(screen.getByRole("button", { name: "Remove sw-unplaced from rack" }));

    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith("/api/topology/devices/3/meta", {
        rack_id: null,
        rack_u_position: null,
      }),
    );
  });

  it("offers no remove action for devices without a rack", async () => {
    renderRacks();
    await screen.findByTestId("tray-item-4");
    expect(screen.queryByTestId("remove-from-rack-4")).toBeNull();
  });

  it("hides every remove action for viewers", async () => {
    mockRole = "viewer";
    renderRacks();
    await screen.findByTestId("faceplate-2");
    await screen.findByTestId("tray-item-3");

    expect(screen.queryByRole("button", { name: /from rack$/ })).toBeNull();
    expect(screen.queryByTestId("remove-from-rack-1")).toBeNull();
    expect(screen.queryByTestId("remove-from-rack-2")).toBeNull();
    expect(screen.queryByTestId("remove-from-rack-3")).toBeNull();
  });
});

describe("Drag a placed device onto the tray", () => {
  // jsdom lays nothing out; give the tray a real box to the right of the rack.
  function stubTrayRect(tray: HTMLElement) {
    vi.spyOn(tray, "getBoundingClientRect").mockReturnValue({
      left: 800,
      right: 1100,
      top: 0,
      bottom: 600,
      width: 300,
      height: 600,
      x: 800,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  it("highlights the tray while dragging and removes the device on drop", async () => {
    renderRacks();
    const fp = await screen.findByTestId("faceplate-2");
    const tray = screen.getByTestId("rack-tray");
    stubTrayRect(tray);
    expect(screen.queryByTestId("rack-tray-drop-hint")).toBeNull();

    fireEvent.pointerDown(fp, { button: 0, clientX: 100, clientY: 100 });
    expect(tray.getAttribute("data-drop-active")).toBe("1");
    expect(screen.getByTestId("rack-tray-drop-hint").textContent).toBe("Drop here to remove from rack");
    expect(tray.getAttribute("data-drop-over")).toBe("0");

    fireEvent.pointerMove(window, { clientX: 900, clientY: 300 });
    expect(tray.getAttribute("data-drop-over")).toBe("1");
    fireEvent.pointerUp(window, { button: 0, clientX: 900, clientY: 300 });

    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith("/api/topology/devices/2/meta", {
        rack_id: null,
        rack_u_position: null,
      }),
    );
    expect(screen.queryByTestId("rack-tray-drop-hint")).toBeNull();
  });

  it("cancels when a placed device is released outside both rack and tray", async () => {
    renderRacks();
    const fp = await screen.findByTestId("faceplate-2");
    const tray = screen.getByTestId("rack-tray");
    stubTrayRect(tray);

    fireEvent.pointerDown(fp, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 1500, clientY: 300 });
    expect(tray.getAttribute("data-drop-over")).toBe("0");
    fireEvent.pointerUp(window, { button: 0, clientX: 1500, clientY: 300 });

    expect(mockApiPatch).not.toHaveBeenCalled();
    expect(tray.getAttribute("data-drop-active")).toBe("0");
  });

  it("does not turn the tray into a drop target for tray items", async () => {
    renderRacks();
    const item = await screen.findByTestId("tray-item-3");
    const tray = screen.getByTestId("rack-tray");
    stubTrayRect(tray);

    fireEvent.pointerDown(item, { button: 0, clientX: 900, clientY: 100 });
    expect(tray.getAttribute("data-drop-active")).toBe("0");
    fireEvent.pointerMove(window, { clientX: 900, clientY: 300 });
    expect(tray.getAttribute("data-drop-over")).toBe("0");
    fireEvent.pointerUp(window, { button: 0, clientX: 900, clientY: 300 });

    expect(mockApiPatch).not.toHaveBeenCalled();
  });
});
