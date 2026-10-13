/**
 * Map page with buildings and floors: floor switcher persistence (URL wins
 * over localStorage), the Unassigned tab only when needed, per-floor
 * background and Auto-Layout visibility, and portal clicks switching floors.
 */
import React from "react";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { installXyflowShims, renderWithRouter, stubMemoryStorage } from "./test-utils";
import type { Building, Floor, RackInfo, TopologyData, TopologyNode } from "../types";

const mockApiGet = vi.fn();
vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(() => Promise.resolve({})),
    del: vi.fn(),
    invalidate: vi.fn(),
  },
  API: "",
  apiUrl: (path: string) => path,
  _getAuthHeader: () => ({}),
  getStoredUser: () => ({ username: "admin", role: "admin" }),
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  normPort: (p: string | null) => (p || "").trim().toLowerCase(),
  buildPortLinkMap: () => ({}),
}));
vi.mock("../hooks/useScanProgress", () => ({ useScanProgress: () => null }));

import MapPage from "../pages/MapPage";
import useNet2MapStore, { loadStoredFloor } from "../store";

beforeAll(() => {
  installXyflowShims();
});

function floor(id: number, label: string, sortOrder: number, extra: Partial<Floor> = {}): Floor {
  return {
    id,
    building_id: 1,
    label,
    sort_order: sortOrder,
    has_background: false,
    bg_version: 0,
    bg_opacity: 0.3,
    bg_scale: 1,
    bg_color: "#020817",
    ...extra,
  };
}

function node(id: number, ip: string, sysName: string, extra: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id,
    ip,
    hostname: "",
    sys_name: sysName,
    vendor: "generic",
    model: "",
    mac: "",
    rack_id: null,
    class_id: null,
    model_id: null,
    x: null,
    y: null,
    map_x: 200,
    map_y: 200,
    ignored: false,
    role: "",
    ports_per_row: 24,
    total_ports: 0,
    ports: [],
    floor_id: null,
    ...extra,
  } as TopologyNode;
}

const BUILDINGS: Building[] = [
  {
    id: 1,
    label: "Main",
    description: null,
    sort_order: 0,
    floors: [floor(10, "Ground", 0, { has_background: true, bg_version: 3 }), floor(11, "First", 1)],
  },
];

const RACKS: RackInfo[] = [
  { id: 1, label: "Core rack", location: "", room: "", row_pos: null, col_pos: null, map_x: 100, map_y: 100, floor_id: 10 },
];

function topology(extraNodes: TopologyNode[] = [], buildings: Building[] = BUILDINGS): TopologyData {
  return {
    nodes: [
      node(1, "10.0.0.1", "core-sw", { rack_id: 1 }),
      node(2, "10.0.0.2", "first-sw", { floor_id: 11 }),
      ...extraNodes,
    ],
    links: [
      {
        id: 1,
        local_ip: "10.0.0.1",
        local_port: "1/1/1",
        remote_ip: "10.0.0.2",
        remote_port: "1/1/1",
        local_sys_name: "core-sw",
        remote_sys_name: "first-sw",
        speed_label: "10G",
      },
    ],
    racks: RACKS,
    classes: [],
    models: [],
    buildings,
  };
}

function mockTopology(data: TopologyData) {
  mockApiGet.mockImplementation((path: string) => {
    if (path === "/api/topology") return Promise.resolve(data);
    return Promise.resolve(null);
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.search}</div>;
}

function renderMap(route = "/map") {
  return renderWithRouter(
    <>
      <MapPage />
      <LocationProbe />
    </>,
    { route },
  );
}

async function activeTab(): Promise<string> {
  const tablist = await screen.findByRole("tablist", { name: "Floor" });
  const selected = within(tablist).getAllByRole("tab").find(t => t.getAttribute("aria-selected") === "true");
  return selected?.textContent ?? "";
}

describe("Map floors", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = stubMemoryStorage();
    useNet2MapStore.setState({ activeFloor: null, focusDeviceId: null, selectedRack: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the first floor and shows only its racks with a floor background", async () => {
    mockTopology(topology());
    const { container } = renderMap();
    expect(await activeTab()).toContain("Ground");
    await waitFor(() => expect(container.querySelector(".react-flow__node-rack")?.textContent).toContain("Core rack"));
    expect(screen.queryByText("first-sw", { selector: ".topo-node-label" })).toBeNull();
    const bg = container.querySelector(".react-flow__node-mapBackground img");
    expect(bg?.getAttribute("src")).toBe("/api/floors/10/background?v=3");
    // Active floor has a floor plan: no Auto-Layout.
    expect(screen.queryByRole("button", { name: "Auto-Layout" })).toBeNull();
  });

  it("URL floor param wins over localStorage and becomes the persisted choice", async () => {
    storage.set("net2map-floor", "10");
    useNet2MapStore.setState({ activeFloor: loadStoredFloor() });
    mockTopology(topology());
    renderMap("/map?floor=11");
    expect(await activeTab()).toContain("First");
    await waitFor(() => expect(storage.get("net2map-floor")).toBe("11"));
    // Floor without a background offers Auto-Layout again.
    expect(screen.getByRole("button", { name: "Auto-Layout" })).toBeTruthy();
  });

  it("uses the persisted floor without a URL param and writes switches to URL and storage", async () => {
    storage.set("net2map-floor", "11");
    useNet2MapStore.setState({ activeFloor: loadStoredFloor() });
    mockTopology(topology());
    renderMap();
    expect(await activeTab()).toContain("First");
    fireEvent.click(screen.getByRole("tab", { name: /Ground/ }));
    expect(await activeTab()).toContain("Ground");
    expect(storage.get("net2map-floor")).toBe("10");
    expect(screen.getByTestId("location").textContent).toContain("floor=10");
  });

  it("offers the Unassigned tab with a count only while something is unassigned", async () => {
    mockTopology(topology());
    const first = renderMap();
    await activeTab();
    expect(screen.queryByRole("tab", { name: /Unassigned/ })).toBeNull();
    first.unmount();

    mockTopology(topology([node(3, "10.0.0.3", "new-sw"), node(4, "10.0.0.4", "new-sw2")]));
    renderMap();
    const tab = await screen.findByRole("tab", { name: /Unassigned/ });
    expect(within(tab).getByTestId("unassigned-count").textContent).toBe("2");
    fireEvent.click(tab);
    expect(await activeTab()).toContain("Unassigned");
    expect(await screen.findByText("new-sw", { selector: ".topo-node-label" })).toBeTruthy();
  });

  it("renders a portal for a cross-floor link and switches floor on click", async () => {
    mockTopology(topology());
    renderMap();
    expect(await activeTab()).toContain("Ground");
    const portal = await screen.findByTestId("portal-node");
    expect(portal.textContent).toContain("First");
    expect(portal.textContent).toContain("first-sw");
    fireEvent.click(portal);
    expect(await activeTab()).toContain("First");
    expect(await screen.findByText("first-sw", { selector: ".topo-node-label" })).toBeTruthy();
    // The portal on First points back to the rack on Ground.
    await waitFor(() => expect(screen.getByTestId("portal-node").textContent).toContain("Core rack"));
  });

  it("switches to the target floor for Show on map focus", async () => {
    mockTopology(topology());
    renderMap();
    expect(await activeTab()).toContain("Ground");
    act(() => useNet2MapStore.getState().setFocusDevice(2));
    expect(await activeTab()).toContain("First");
    await waitFor(() => expect(useNet2MapStore.getState().focusDeviceId).toBeNull());
  });

  it("behaves like before without buildings: no switcher, everything shown", async () => {
    mockTopology(topology([], []));
    const { container } = renderMap();
    await waitFor(() => expect(container.querySelector(".react-flow__node-rack")).toBeTruthy());
    expect(await screen.findByText("first-sw", { selector: ".topo-node-label" })).toBeTruthy();
    expect(screen.queryByTestId("floor-switcher")).toBeNull();
    expect(screen.queryByTestId("portal-node")).toBeNull();
    expect(screen.getByRole("button", { name: "Auto-Layout" })).toBeTruthy();
  });
});
