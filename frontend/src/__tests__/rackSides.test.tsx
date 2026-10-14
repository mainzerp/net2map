/**
 * Tests for the two-sided rack elevation: the side-aware occupancy rule in
 * rackLayout.ts (front / rear / full depth), front and rear faces rendered
 * side by side with full-depth shadows, dragging devices and rack items
 * between faces, the full-depth toggle, the item palette and the item
 * dialog's side / full-depth fields.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithRouter } from "./test-utils";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPatch = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
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
  U_PX,
  buildLayoutEntries,
  computeDropTarget,
  footprintsConflict,
  itemBlocks,
  itemPlacementError,
  occupiedSides,
  placementValid,
  topmostFreeU,
  usedUnits,
  type Placement,
} from "../features/racks/rackLayout";
import type { RackItem, TopologyData, TopologyNode } from "../types";

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

function makeItem(partial: Partial<RackItem>): RackItem {
  return {
    id: 1,
    rack_id: 1,
    kind: "patch_panel",
    label: "",
    rack_u_position: 1,
    u_height: 1,
    note: null,
    ...partial,
  };
}

// ── Pure occupancy rule ─────────────────────────────────────────────────────

describe("rackLayout side-aware occupancy", () => {
  it("occupiedSides defaults to front and covers both faces for full depth", () => {
    expect(occupiedSides({})).toEqual(["front"]);
    expect(occupiedSides({ side: "rear" })).toEqual(["rear"]);
    expect(occupiedSides({ side: "rear", fullDepth: true })).toEqual(["front", "rear"]);
  });

  it("footprintsConflict needs overlapping U ranges and intersecting faces", () => {
    const front = { pos: 1, uHeight: 2, side: "front" as const };
    expect(footprintsConflict(front, { pos: 2, uHeight: 1, side: "front" })).toBe(true);
    expect(footprintsConflict(front, { pos: 2, uHeight: 1, side: "rear" })).toBe(false);
    expect(footprintsConflict(front, { pos: 2, uHeight: 1, side: "rear", fullDepth: true })).toBe(true);
    expect(footprintsConflict({ ...front, fullDepth: true }, { pos: 1, uHeight: 1, side: "rear" })).toBe(true);
    // No U overlap: never a conflict, even for full depth on both
    expect(
      footprintsConflict({ ...front, fullDepth: true }, { pos: 3, uHeight: 1, side: "rear", fullDepth: true }),
    ).toBe(false);
    // Missing side means front
    expect(footprintsConflict({ pos: 1, uHeight: 1 }, front)).toBe(true);
  });

  const placements: Placement[] = [
    { deviceId: 1, pos: 1, uHeight: 2, side: "front", fullDepth: false }, // front U1-U2
    { deviceId: 2, pos: 5, uHeight: 1, side: "rear", fullDepth: false }, // rear U5
    { deviceId: 3, pos: 8, uHeight: 2, side: "front", fullDepth: true }, // both U8-U9
  ];

  it("placementValid allows the other face and rejects full-depth conflicts", () => {
    expect(placementValid(placements, 9, 1, 1, 12, [], { side: "rear" })).toBe(true);
    expect(placementValid(placements, 9, 1, 1, 12, [], { side: "front" })).toBe(false);
    expect(placementValid(placements, 9, 1, 1, 12, [], { side: "rear", fullDepth: true })).toBe(false);
    expect(placementValid(placements, 9, 5, 1, 12, [], { side: "front" })).toBe(true);
    expect(placementValid(placements, 9, 8, 1, 12, [], { side: "rear" })).toBe(false);
    // Moving device 3 itself: its own footprint does not block it
    expect(placementValid(placements, 3, 8, 2, 12, [], { side: "rear", fullDepth: true })).toBe(true);
    // A full-depth item blocks both faces
    expect(placementValid(placements, 9, 11, 1, 12, [{ pos: 11, uHeight: 1, side: "rear", fullDepth: true }], { side: "front" })).toBe(false);
    expect(placementValid(placements, 9, 11, 1, 12, [{ pos: 11, uHeight: 1, side: "rear" }], { side: "front" })).toBe(true);
  });

  it("computeDropTarget carries the side and validates per face", () => {
    // Row 10 from the top, height 2 -> pos 1
    const rear = computeDropTarget(placements, 9, 10, 2, 12, [], { side: "rear" });
    expect(rear).toEqual({ pos: 1, row: 10, side: "rear", valid: true });
    const front = computeDropTarget(placements, 9, 10, 2, 12, [], { side: "front" });
    expect(front).toEqual({ pos: 1, row: 10, side: "front", valid: false });
    // Default side is front
    expect(computeDropTarget(placements, 9, 0, 1, 12).side).toBe("front");
  });

  it("itemBlocks and itemPlacementError respect side and full depth", () => {
    expect(itemBlocks([{ id: 4, rack_u_position: 3, u_height: 1, rack_side: "rear", full_depth: true }], 12)).toEqual([
      { id: 4, pos: 3, uHeight: 1, side: "rear", fullDepth: true },
    ]);
    const items = [{ id: 7, rack_u_position: 10, u_height: 1, rack_side: "rear" as const }];
    expect(itemPlacementError(10, 1, 12, placements, items, null, { side: "front" })).toBeNull();
    expect(itemPlacementError(10, 1, 12, placements, items, null, { side: "front", fullDepth: true })).toBe(
      "Overlaps another rack item",
    );
    expect(itemPlacementError(1, 1, 12, placements, items, null, { side: "rear" })).toBeNull();
    expect(itemPlacementError(8, 1, 12, placements, items, null, { side: "rear" })).toBe("Overlaps a placed device");
  });

  it("usedUnits counts per face, full depth on both", () => {
    expect(usedUnits(placements, [], "front")).toBe(4);
    expect(usedUnits(placements, [], "rear")).toBe(3);
    expect(usedUnits(placements, [{ pos: 11, uHeight: 1, side: "rear", fullDepth: true }], "front")).toBe(5);
    // Without a side: plain sum of all footprints
    expect(usedUnits(placements)).toBe(5);
  });

  it("topmostFreeU searches the requested face and height", () => {
    const occupied = [{ pos: 12, uHeight: 1, side: "front" as const }];
    expect(topmostFreeU(12, occupied)).toBe(11);
    expect(topmostFreeU(12, occupied, { side: "rear" })).toBe(12);
    expect(topmostFreeU(12, occupied, { side: "rear", fullDepth: true })).toBe(11);
    expect(topmostFreeU(12, occupied, { side: "front" }, 2)).toBe(10);
  });

  it("buildLayoutEntries persists rack_side and full_depth", () => {
    expect(buildLayoutEntries(placements)).toEqual([
      { device_id: 1, rack_u_position: 1, u_height: 2, rack_side: "front", full_depth: false },
      { device_id: 2, rack_u_position: 5, u_height: 1, rack_side: "rear", full_depth: false },
      { device_id: 3, rack_u_position: 8, u_height: 2, rack_side: "front", full_depth: true },
    ]);
    // Missing values fall back to the API defaults
    expect(buildLayoutEntries([{ deviceId: 4, pos: 2, uHeight: 1 }])).toEqual([
      { device_id: 4, rack_u_position: 2, u_height: 1, rack_side: "front", full_depth: false },
    ]);
  });
});

// ── Elevation UI ─────────────────────────────────────────────────────────────

const TOPOLOGY: TopologyData = {
  nodes: [
    makeNode({ id: 1, ip: "10.0.0.1", sys_name: "sw-front", rack_id: 1, rack_u_position: 1, u_height: 2 }),
    makeNode({ id: 2, ip: "10.0.0.2", sys_name: "sw-rear", rack_id: 1, rack_u_position: 5, rack_side: "rear" }),
    makeNode({
      id: 3, ip: "10.0.0.3", sys_name: "srv-deep", rack_id: 1, rack_u_position: 8, u_height: 2,
      rack_side: "front", full_depth: true,
    }),
    makeNode({ id: 4, ip: "10.0.0.4", sys_name: "sw-norack", rack_id: null, rack_u_position: null }),
    makeNode({ id: 5, ip: "10.0.0.5", sys_name: "sw-conflict", rack_id: 1, rack_u_position: 5, rack_side: "front" }),
  ],
  links: [],
  racks: [
    { id: 1, label: "Rack A", location: "", room: "RZ-01", height_u: 12, row_pos: null, col_pos: null },
  ],
  classes: [],
  models: [],
};

const ITEMS: RackItem[] = [
  makeItem({ id: 7, label: "PP-01", rack_u_position: 10, u_height: 1 }),
  makeItem({ id: 8, kind: "shelf", label: "Deep shelf", rack_u_position: 3, u_height: 1, rack_side: "rear", full_depth: true }),
];

const HEIGHT_U = 12;
const FRONT_LEFT = 0;
const REAR_LEFT = 800;
const BODY_WIDTH = 440;

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

// jsdom lays nothing out: give both rack bodies a real box (front at x 0,
// rear at x 800, both 12U tall from y 0).
function stubBodies() {
  for (const [side, left] of [["front", FRONT_LEFT], ["rear", REAR_LEFT]] as const) {
    const body = screen.getByTestId(`rack-body-${side}`);
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue({
      left,
      right: left + BODY_WIDTH,
      top: 0,
      bottom: HEIGHT_U * U_PX,
      width: BODY_WIDTH,
      height: HEIGHT_U * U_PX,
      x: left,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }
}

// Pointer position over the given face whose snapped drop target has its
// bottom U at pos for an object of the given height.
function pointAt(side: "front" | "rear", pos: number, uHeight: number) {
  const row = HEIGHT_U - pos - uHeight + 1;
  return { clientX: (side === "front" ? FRONT_LEFT : REAR_LEFT) + 100, clientY: row * U_PX + 5 };
}

function dragTo(el: HTMLElement, point: { clientX: number; clientY: number }) {
  fireEvent.pointerDown(el, { button: 0, clientX: 300, clientY: 400 });
  fireEvent.pointerMove(window, point);
}

function pressAndRelease(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(window, { button: 0, clientX: 101, clientY: 100 });
}

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
    if (path === "/api/racks/1/items") return Promise.resolve(structuredClone(ITEMS));
    return Promise.resolve([]);
  });
  mockApiPost.mockResolvedValue({});
  mockApiPatch.mockResolvedValue({});
});

describe("RackElevation front and rear faces", () => {
  it("draws each object on its own face and full-depth objects as shadows on the other", async () => {
    renderRacks();
    await screen.findByTestId("rack-item-8");
    const front = screen.getByTestId("rack-body-front");
    const rear = screen.getByTestId("rack-body-rear");

    expect(within(front).getByTestId("faceplate-1")).toBeTruthy();
    expect(within(rear).getByTestId("faceplate-2")).toBeTruthy();
    expect(within(front).getByTestId("faceplate-3")).toBeTruthy();
    expect(within(rear).queryByTestId("faceplate-3")).toBeNull();
    // Full-depth device: shadow on the rear at the same row
    const shadow = within(rear).getByTestId("rack-shadow-device-3");
    expect((shadow.parentElement as HTMLElement).style.top).toBe(
      (screen.getByTestId("faceplate-3").parentElement as HTMLElement).style.top,
    );
    expect(shadow.getAttribute("aria-label")).toBe("srv-deep (full depth, mounted on the front) - open details");
    // Full-depth rear item: plate on the rear, shadow on the front
    expect(within(rear).getByTestId("rack-item-8")).toBeTruthy();
    expect(within(front).getByTestId("rack-shadow-item-8")).toBeTruthy();
    expect(within(front).getByTestId("rack-item-7")).toBeTruthy();

    // Labels live in the label column of the mounted face only
    expect(within(screen.getByTestId("rack-label-column-rear")).getByTestId("rack-label-2")).toBeTruthy();
    expect(within(screen.getByTestId("rack-label-column-front")).getByTestId("rack-label-3")).toBeTruthy();
    expect(within(screen.getByTestId("rack-label-column-rear")).queryByTestId("rack-label-3")).toBeNull();

    // Occupancy per face: front 2 + 1 + 2 + 1 (item 7) + 1 (item 8 shadow) = 7,
    // rear 1 + 2 (device 3 shadow) + 1 (item 8) = 4
    expect(within(screen.getByTestId("rack-side-front")).getByText("7/12 U used - 5 U free")).toBeTruthy();
    expect(within(screen.getByTestId("rack-side-rear")).getByText("4/12 U used - 8 U free")).toBeTruthy();
  });

  it("opens the inspector from a shadow without starting a drag", async () => {
    renderRacks();
    const shadow = await screen.findByTestId("rack-shadow-device-3");
    fireEvent.pointerDown(shadow, { button: 0, clientX: 900, clientY: 100 });
    expect(screen.getByTestId("faceplate-3").className).not.toContain("opacity-40");
    fireEvent.pointerUp(window, { button: 0, clientX: 900, clientY: 100 });
    fireEvent.click(shadow);
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?rack=1&inspect=device:3"));
    expect(mockApiPatch).not.toHaveBeenCalled();
  });

  it("moves a device from the front to the rear by dragging", async () => {
    renderRacks();
    const fp = await screen.findByTestId("faceplate-1");
    await screen.findByTestId("rack-item-8");
    stubBodies();

    const point = pointAt("rear", 1, 2);
    dragTo(fp, point);
    const ghost = within(screen.getByTestId("rack-body-rear")).getByTestId("drop-ghost");
    expect(ghost.getAttribute("data-valid")).toBe("1");
    expect(ghost.getAttribute("data-side")).toBe("rear");
    fireEvent.pointerUp(window, { button: 0, ...point });

    await waitFor(() => expect(mockApiPatch).toHaveBeenCalledTimes(1));
    const [path, body] = mockApiPatch.mock.calls[0] as [string, { entries: unknown[] }];
    expect(path).toBe("/api/racks/1/layout");
    expect(body.entries).toContainEqual({ device_id: 1, rack_u_position: 1, u_height: 2, rack_side: "rear", full_depth: false });
    // Other devices keep their side and depth
    expect(body.entries).toContainEqual({ device_id: 2, rack_u_position: 5, u_height: 1, rack_side: "rear", full_depth: false });
    expect(body.entries).toContainEqual({ device_id: 3, rack_u_position: 8, u_height: 2, rack_side: "front", full_depth: true });
  });

  it("rejects a drop onto a full-depth shadow and shows a red ghost", async () => {
    renderRacks();
    const fp = await screen.findByTestId("faceplate-2");
    await screen.findByTestId("rack-item-8");
    stubBodies();

    const point = pointAt("rear", 8, 1);
    dragTo(fp, point);
    expect(screen.getByTestId("drop-ghost").getAttribute("data-valid")).toBe("0");
    fireEvent.pointerUp(window, { button: 0, ...point });
    expect(mockApiPatch).not.toHaveBeenCalled();
  });

  it("previews both faces while dragging a full-depth device", async () => {
    renderRacks();
    const fp = await screen.findByTestId("faceplate-3");
    await screen.findByTestId("rack-item-8");
    stubBodies();

    dragTo(fp, pointAt("front", 11, 2));
    expect(within(screen.getByTestId("rack-body-front")).getByTestId("drop-ghost")).toBeTruthy();
    const shadowGhost = within(screen.getByTestId("rack-body-rear")).getByTestId("drop-ghost-shadow");
    expect(shadowGhost.getAttribute("data-valid")).toBe("1");
    fireEvent.pointerUp(window, { button: 0, ...pointAt("front", 11, 2) });
  });
});

describe("Full-depth toggle", () => {
  it("marks a device as full depth via the faceplate control", async () => {
    renderRacks();
    await screen.findByTestId("rack-item-8");
    const toggle = screen.getByRole("button", { name: "Full depth for sw-front" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith("/api/topology/devices/1/meta", { full_depth: true }),
    );
  });

  it("refuses locally with a toast when the opposite face is occupied", async () => {
    renderRacks();
    await screen.findByTestId("rack-item-8");
    fireEvent.click(screen.getByRole("button", { name: "Full depth for sw-conflict" }));
    expect(await screen.findByText("Cannot make sw-conflict full depth: U5 on the rear is occupied")).toBeTruthy();
    expect(mockApiPatch).not.toHaveBeenCalled();
  });

  it("clears full depth without a conflict check", async () => {
    renderRacks();
    await screen.findByTestId("rack-item-8");
    const toggle = screen.getByRole("button", { name: "Full depth for srv-deep" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith("/api/topology/devices/3/meta", { full_depth: false }),
    );
  });
});

describe("Rack item palette", () => {
  it("lists every item kind with its default height", async () => {
    renderRacks();
    const palette = await screen.findByTestId("rack-item-palette");
    for (const [kind, label, u] of [
      ["patch_panel", "Patch panel", "1U"],
      ["blank", "Blank panel", "1U"],
      ["cable_manager", "Cable manager", "1U"],
      ["shelf", "Shelf", "2U"],
      ["other", "Other", "1U"],
    ]) {
      const entry = within(palette).getByTestId(`palette-item-${kind}`);
      expect(within(entry).getByText(label)).toBeTruthy();
      expect(within(entry).getByText(u)).toBeTruthy();
    }
  });

  it("creates an item at the drop U and side, repeatedly", async () => {
    renderRacks();
    await screen.findByTestId("rack-item-8");
    stubBodies();
    const shelf = screen.getByTestId("palette-item-shelf");

    const point = pointAt("rear", 10, 2);
    for (let i = 0; i < 2; i++) {
      dragTo(shelf, point);
      expect(screen.getByTestId("drop-ghost").getAttribute("data-valid")).toBe("1");
      fireEvent.pointerUp(window, { button: 0, ...point });
    }

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(2));
    expect(mockApiPost).toHaveBeenCalledWith("/api/racks/1/items", {
      kind: "shelf",
      label: "",
      rack_u_position: 10,
      u_height: 2,
      rack_side: "rear",
      full_depth: false,
      note: null,
    });
    // No dialog for drag-create
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not create an item on a conflicting drop", async () => {
    renderRacks();
    await screen.findByTestId("rack-item-8");
    stubBodies();
    const point = pointAt("front", 10, 1); // item 7 sits at front U10
    dragTo(screen.getByTestId("palette-item-blank"), point);
    expect(screen.getByTestId("drop-ghost").getAttribute("data-valid")).toBe("0");
    fireEvent.pointerUp(window, { button: 0, ...point });
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("opens the item dialog prefilled with the kind on click or Enter", async () => {
    renderRacks();
    await screen.findByTestId("rack-item-8");
    pressAndRelease(screen.getByTestId("palette-item-shelf"));
    let dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Type") as HTMLSelectElement).value).toBe("shelf");
    expect((within(dialog).getByLabelText("U height") as HTMLInputElement).value).toBe("2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.keyDown(screen.getByTestId("palette-item-cable_manager"), { key: "Enter" });
    dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Type") as HTMLSelectElement).value).toBe("cable_manager");
  });
});

describe("Rack item drag", () => {
  it("moves an item to another U and side via the update mutation", async () => {
    renderRacks();
    const plate = await screen.findByTestId("rack-item-7");
    stubBodies();

    const point = pointAt("rear", 12, 1);
    dragTo(plate, point);
    expect(plate.className).toContain("opacity-40");
    expect(screen.getByTestId("drop-ghost").getAttribute("data-valid")).toBe("1");
    fireEvent.pointerUp(window, { button: 0, ...point });

    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith("/api/rack-items/7", { rack_u_position: 12, rack_side: "rear" }),
    );
    // Items never turn the tray into a removal target
    expect(screen.getByTestId("rack-tray").getAttribute("data-drop-active")).toBe("0");
  });

  it("rolls back and toasts when the item move fails", async () => {
    mockApiPatch.mockRejectedValue(new Error("U12 is occupied"));
    renderRacks();
    const plate = await screen.findByTestId("rack-item-7");
    stubBodies();

    const point = pointAt("rear", 12, 1);
    dragTo(plate, point);
    fireEvent.pointerUp(window, { button: 0, ...point });

    expect(await screen.findByText("Rack item not saved: U12 is occupied")).toBeTruthy();
    await waitFor(() =>
      expect(within(screen.getByTestId("rack-body-front")).getByTestId("rack-item-7")).toBeTruthy(),
    );
  });

  it("opens the item dialog on a click below the drag threshold", async () => {
    renderRacks();
    pressAndRelease(await screen.findByTestId("rack-item-7"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit rack item")).toBeTruthy();
    expect(mockApiPatch).not.toHaveBeenCalled();
  });
});

describe("RackItemDialog side and full depth", () => {
  it("shows the stored side and full-depth flag", async () => {
    renderRacks();
    pressAndRelease(await screen.findByTestId("rack-item-8"));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Side") as HTMLSelectElement).value).toBe("rear");
    expect((within(dialog).getByLabelText("Full depth") as HTMLInputElement).checked).toBe(true);
  });

  it("saves a changed side and full-depth flag", async () => {
    renderRacks();
    pressAndRelease(await screen.findByTestId("rack-item-7"));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Side") as HTMLSelectElement).value).toBe("front");
    fireEvent.change(within(dialog).getByLabelText("Side"), { target: { value: "rear" } });
    fireEvent.click(within(dialog).getByLabelText("Full depth"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith("/api/rack-items/7", {
        kind: "patch_panel",
        label: "PP-01",
        rack_u_position: 10,
        u_height: 1,
        rack_side: "rear",
        full_depth: true,
        note: null,
      }),
    );
  });

  it("flags a full-depth conflict on the other face", async () => {
    renderRacks();
    pressAndRelease(await screen.findByTestId("rack-item-7"));
    const dialog = await screen.findByRole("dialog");
    // Rear U5 holds sw-rear; front U5 holds sw-conflict
    fireEvent.change(within(dialog).getByLabelText("U position (bottom)"), { target: { value: "4" } });
    expect(within(dialog).queryByTestId("rack-item-placement-error")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("U position (bottom)"), { target: { value: "3" } });
    // Item 8 is a full-depth rear shelf at U3
    expect(within(dialog).getByTestId("rack-item-placement-error").textContent).toBe("Overlaps another rack item");
  });
});
