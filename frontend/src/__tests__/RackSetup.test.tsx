/**
 * Rack setup flow: the shared RackFormModal (floor hint, height validation),
 * the Settings > Racks card usage summary and assignment errors, and the
 * /racks page create/edit buttons, header line and class stripe.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";
import type { Building, TopologyData, TopologyNode } from "../types";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();
const mockApiPatch = vi.fn();
let mockRole = "admin";

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: (...args: unknown[]) => mockApiPut(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    del: vi.fn(),
    invalidate: vi.fn(),
  },
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  getStoredUser: () => ({ username: "u", role: mockRole }),
  getStoredToken: () => "token",
  normPort: (s: string) => (s || "").trim().toLowerCase(),
  API: "",
}));

// Must import after mocks are set up
import RackFormModal from "../features/racks/RackFormModal";
import RacksTabContent from "../components/settings/RacksTab";
import RacksPage from "../pages/RacksPage";

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

const BUILDINGS: Building[] = [
  {
    id: 1,
    label: "HQ",
    description: null,
    sort_order: 0,
    floors: [
      { id: 10, building_id: 1, label: "Ground", sort_order: 0, has_background: false, bg_version: 0, bg_opacity: 0.3, bg_scale: 1, bg_color: "" },
    ],
  },
];

const RACK = { id: 1, label: "Rack A", location: "", room: "RZ-01", height_u: 12, row_pos: null, col_pos: null, floor_id: 10 };

const NODES: TopologyNode[] = [
  makeNode({ id: 1, sys_name: "sw-a", rack_id: 1, rack_u_position: 1, u_height: 2, class_id: 5 }),
  makeNode({ id: 2, sys_name: "sw-b", rack_id: 1, rack_u_position: 5 }),
  makeNode({ id: 3, sys_name: "sw-c", rack_id: 1, rack_u_position: null }),
  makeNode({ id: 4, sys_name: "sw-free", ip: "10.0.0.4", rack_id: null }),
];

const TOPOLOGY: TopologyData = {
  nodes: NODES,
  links: [],
  racks: [RACK],
  classes: [{ id: 5, label: "Core", color: "#ff0000", allow_outside_rack: false }],
  models: [],
  buildings: BUILDINGS,
};

function mockGets({ buildings = BUILDINGS, racks = [RACK] }: { buildings?: Building[]; racks?: unknown[] } = {}) {
  mockApiGet.mockImplementation((path: string) => {
    if (path === "/api/buildings") return Promise.resolve(buildings);
    if (path === "/api/racks") return Promise.resolve(racks);
    if (path === "/api/devices") return Promise.resolve(NODES);
    if (path === "/api/topology") return Promise.resolve(structuredClone(TOPOLOGY));
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = "admin";
  mockGets();
  mockApiPost.mockResolvedValue({});
  mockApiPut.mockResolvedValue({});
  mockApiPatch.mockResolvedValue({});
});

describe("RackFormModal", () => {
  it("disables the floor select and links to floor setup when no floors exist", async () => {
    mockGets({ buildings: [] });
    renderWithRouter(<RackFormModal open onClose={() => {}} />);
    const link = await screen.findByRole("link", { name: "Create a building and floor first" });
    expect(link.getAttribute("href")).toBe("/settings/floors");
    expect((screen.getByLabelText(/Floor/) as HTMLSelectElement).disabled).toBe(true);
  });

  it("lists floors prefixed with the building name", async () => {
    renderWithRouter(<RackFormModal open onClose={() => {}} />);
    expect(await screen.findByRole("option", { name: "HQ / Ground" })).toBeTruthy();
  });

  it("shows a range error for height 70 instead of clamping and does not save", async () => {
    renderWithRouter(<RackFormModal open onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/Label/), { target: { value: "Rack Z" } });
    expect(screen.getByText("6-60 U")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Height \(U\)/), { target: { value: "70" } });
    expect(await screen.findByText("Height must be a whole number from 6 to 60 U")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create rack" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("creates a rack and reports the new rack once the list contains it", async () => {
    let created = false;
    mockApiPost.mockImplementation(() => {
      created = true;
      return Promise.resolve({});
    });
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/buildings") return Promise.resolve(BUILDINGS);
      if (path === "/api/racks") {
        return Promise.resolve(created ? [RACK, { ...RACK, id: 9, label: "Rack Z", floor_id: null }] : [RACK]);
      }
      return Promise.resolve([]);
    });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    renderWithRouter(<RackFormModal open onClose={onClose} onSaved={onSaved} />);
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith("/api/racks"));
    fireEvent.change(await screen.findByLabelText(/Label/), { target: { value: "Rack Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Create rack" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 9, label: "Rack Z" })));
    expect(mockApiPost).toHaveBeenCalledWith("/api/racks", {
      label: "Rack Z",
      room: "",
      description: "",
      height_u: 42,
      floor_id: null,
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("RacksTab cards", () => {
  it("shows the placed/unplaced summary and a link to place unplaced devices", async () => {
    renderWithRouter(<RacksTabContent newEntryTrigger={0} />);
    const usage = await screen.findByTestId("rack-usage-1");
    await waitFor(() => expect(usage.textContent).toBe("2 placed, 1 unplaced, 3/12 U used"));
    const link = screen.getByRole("link", { name: "Place 1 unplaced" });
    expect(link.getAttribute("href")).toBe("/racks?rack=1");
    expect(screen.getByText("Adds the device to this rack without a U position; place it on the Racks page.")).toBeTruthy();
  });

  it("shows an assignment failure under the card", async () => {
    mockApiPatch.mockRejectedValue(new Error("boom"));
    renderWithRouter(<RacksTabContent newEntryTrigger={0} />);
    await screen.findByTestId("rack-usage-1");
    fireEvent.click(await screen.findByRole("button", { name: "Unassign sw-c" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Unassign failed: boom");
  });

  it("opens the create dialog when the new entry trigger increments", async () => {
    renderWithRouter(<RacksTabContent newEntryTrigger={1} />);
    expect(await screen.findByRole("button", { name: "Create rack" })).toBeTruthy();
  });
});

describe("RacksPage rack setup", () => {
  it("offers New rack and Edit rack to admins and shows the rack facts", async () => {
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    expect(await screen.findByRole("button", { name: "New rack" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit rack" })).toBeTruthy();
    expect(screen.getByTestId("rack-header-facts").textContent).toBe("Room RZ-01 - HQ / Ground - 12U");
    expect(screen.getByRole("link", { name: "All racks in Settings" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit rack" }));
    const label = (await screen.findByLabelText(/Label/)) as HTMLInputElement;
    expect(label.value).toBe("Rack A");
  });

  it("hides the rack buttons for viewers", async () => {
    mockRole = "viewer";
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    await screen.findByTestId("rack-header-facts");
    expect(screen.queryByRole("button", { name: "New rack" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit rack" })).toBeNull();
  });

  it("offers New rack in the empty state", async () => {
    mockApiGet.mockImplementation((path: string) =>
      Promise.resolve(path === "/api/topology" ? { ...TOPOLOGY, racks: [], nodes: [] } : []),
    );
    renderWithRouter(<RacksPage />, { route: "/racks" });
    expect(await screen.findByRole("button", { name: "New rack" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "All racks in Settings" })).toBeTruthy();
  });

  it("draws the class color stripe on classed faceplates", async () => {
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    const stripe = await screen.findByTestId("faceplate-class-1");
    expect(stripe.getAttribute("title")).toBe("Class: Core");
    expect(screen.queryByTestId("faceplate-class-2")).toBeNull();
  });
});
