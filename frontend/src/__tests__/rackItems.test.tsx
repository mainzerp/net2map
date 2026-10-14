/**
 * Tests for manual rack items (patch panels, blanks, ...): the pure collision
 * helpers in rackLayout.ts and the item rendering / dialog in RackElevation.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPatch = vi.fn();
const mockApiDel = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: vi.fn(),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    del: (...args: unknown[]) => mockApiDel(...args),
    invalidate: vi.fn(),
  },
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  getStoredUser: () => ({ username: "admin", role: "admin" }),
  getStoredToken: () => "token",
  normPort: (s: string) => (s || "").trim().toLowerCase(),
  API: "",
}));

// Must import after mocks are set up
import RackElevation from "../features/racks/RackElevation";
import {
  U_PX,
  computeDropTarget,
  itemBlocks,
  itemPlacementError,
  placementValid,
  rowFromTop,
  usedUnits,
  type Placement,
} from "../features/racks/rackLayout";
import type { RackInfo, RackItem, TopologyNode } from "../types";

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

const RACK: RackInfo = { id: 1, label: "Rack A", location: "", room: "RZ-01", height_u: 12, row_pos: null, col_pos: null };
const NODES: TopologyNode[] = [
  makeNode({ id: 1, ip: "10.0.0.1", sys_name: "sw-bottom", rack_id: 1, rack_u_position: 1, u_height: 2 }),
];
const ITEMS: RackItem[] = [
  makeItem({ id: 7, label: "PP-01", rack_u_position: 10, u_height: 1, note: "Floor 2" }),
  makeItem({ id: 8, kind: "blank", label: "", rack_u_position: 5, u_height: 2 }),
];

describe("rackLayout rack item collision helpers", () => {
  const placements: Placement[] = [{ deviceId: 1, pos: 1, uHeight: 2 }];

  it("itemBlocks converts items to blocked ranges and drops out-of-range items", () => {
    const blocks = itemBlocks(
      [
        { id: 1, rack_u_position: 3, u_height: 2 },
        { id: 2, rack_u_position: 12, u_height: 2 }, // 12-13 exceeds a 12U rack
        { id: 3, rack_u_position: 0, u_height: 1 },
      ],
      12,
    );
    expect(blocks).toEqual([{ id: 1, pos: 3, uHeight: 2, side: "front", fullDepth: false }]);
  });

  it("placementValid rejects device positions overlapping a blocked range", () => {
    const blocked = [{ pos: 3, uHeight: 2 }]; // U3-U4
    expect(placementValid(placements, 2, 4, 1, 12, blocked)).toBe(false);
    expect(placementValid(placements, 2, 2, 2, 12, blocked)).toBe(false);
    expect(placementValid(placements, 2, 5, 1, 12, blocked)).toBe(true);
  });

  it("computeDropTarget flags drops onto a rack item as invalid, even for the device's own range", () => {
    // Device 1 itself may sit at U1-U2, but not when an item blocks U2.
    expect(computeDropTarget(placements, 1, 10, 2, 12).valid).toBe(true);
    expect(computeDropTarget(placements, 1, 10, 2, 12, [{ pos: 2, uHeight: 1 }]).valid).toBe(false);
  });

  it("itemPlacementError mirrors the backend fit and overlap rules", () => {
    const items = [{ id: 7, rack_u_position: 10, u_height: 1 }];
    expect(itemPlacementError(6, 1, 12, placements, items)).toBeNull();
    expect(itemPlacementError(12, 2, 12, placements, items)).toMatch(/does not fit/);
    expect(itemPlacementError(2, 1, 12, placements, items)).toBe("Overlaps a placed device");
    expect(itemPlacementError(9, 2, 12, placements, items)).toBe("Overlaps another rack item");
    // Editing item 7 in place does not collide with itself
    expect(itemPlacementError(10, 1, 12, placements, items, 7)).toBeNull();
    expect(itemPlacementError(0, 1, 12, placements, items)).toMatch(/positive whole numbers/);
  });

  it("usedUnits counts devices and rack items", () => {
    expect(usedUnits(placements)).toBe(2);
    expect(usedUnits(placements, [{ pos: 5, uHeight: 3 }])).toBe(5);
  });
});

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

// Editable item plates and palette entries open via the click-vs-drag
// threshold of the pointer drag, not via a native click.
function pressAndRelease(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(window, { button: 0, clientX: 101, clientY: 100 });
}

describe("RackElevation rack items", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/racks/1/items") return Promise.resolve(structuredClone(ITEMS));
      return Promise.resolve([]);
    });
    mockApiPost.mockResolvedValue({});
    mockApiPatch.mockResolvedValue({});
    mockApiDel.mockResolvedValue(undefined);
  });

  it("renders items at their U range with a muted faceplate and a label", async () => {
    renderWithRouter(<RackElevation rack={RACK} nodes={NODES} />);

    const pp = await screen.findByTestId("rack-item-7");
    expect(pp.getAttribute("data-kind")).toBe("patch_panel");
    expect((pp.parentElement as HTMLElement).style.top).toBe(`${rowFromTop(12, 10, 1) * U_PX + 1}px`);
    expect(within(pp).getByTestId("rack-item-ports").querySelectorAll("span").length).toBe(24);
    expect(pp.getAttribute("aria-label")).toBe("PP-01 (Patch panel) - edit");

    const blank = screen.getByTestId("rack-item-8");
    expect(blank.getAttribute("data-kind")).toBe("blank");
    expect(within(blank).queryByTestId("rack-item-ports")).toBeNull();
    expect((blank.parentElement as HTMLElement).style.height).toBe(`${2 * U_PX - 2}px`);

    expect(within(screen.getByTestId("rack-item-label-7")).getByText("PP-01")).toBeTruthy();
    expect(within(screen.getByTestId("rack-item-label-8")).getByText("Blank panel")).toBeTruthy();
    // 2 (device) + 1 (patch panel) + 2 (blank) = 5 used
    expect(screen.getByText("5/12 U used - 7 U free")).toBeTruthy();
  });

  it("creates an item through the dialog opened from the item palette", async () => {
    renderWithRouter(<RackElevation rack={RACK} nodes={NODES} />);
    await screen.findByTestId("rack-item-7");
    expect(screen.queryByTestId("rack-add-item")).toBeNull();

    pressAndRelease(screen.getByTestId("palette-item-patch_panel"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Add rack item")).toBeTruthy();
    // Topmost free U in a 12U rack with U10 taken is U12
    expect((within(dialog).getByLabelText("U position (bottom)") as HTMLInputElement).value).toBe("12");

    fireEvent.change(within(dialog).getByLabelText("Label"), { target: { value: "PP-02" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add item" }));

    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/racks/1/items", {
        kind: "patch_panel",
        label: "PP-02",
        rack_u_position: 12,
        u_height: 1,
        rack_side: "front",
        full_depth: false,
        note: null,
      }),
    );
  });

  it("blocks saving an overlapping position in the dialog", async () => {
    renderWithRouter(<RackElevation rack={RACK} nodes={NODES} />);
    pressAndRelease(await screen.findByTestId("rack-item-7"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit rack item")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("U position (bottom)"), { target: { value: "6" } });
    expect(within(dialog).getByTestId("rack-item-placement-error").textContent).toBe("Overlaps another rack item");
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("deletes an item after confirmation", async () => {
    renderWithRouter(<RackElevation rack={RACK} nodes={NODES} />);
    pressAndRelease(await screen.findByTestId("rack-item-7"));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(mockApiDel).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(mockApiDel).toHaveBeenCalledWith("/api/rack-items/7"));
  });

  it("hides write actions for read-only users", async () => {
    renderWithRouter(<RackElevation rack={RACK} nodes={NODES} readOnly />);
    const pp = await screen.findByTestId("rack-item-7");
    expect(screen.queryByTestId("rack-add-item")).toBeNull();
    expect(screen.queryByTestId("rack-item-palette")).toBeNull();

    // No drag in read-only mode: a press does not dim the plate.
    fireEvent.pointerDown(pp, { button: 0, clientX: 100, clientY: 100 });
    expect(pp.className).not.toContain("opacity-40");
    fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 100 });

    fireEvent.click(pp);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Rack item")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    expect((within(dialog).getByLabelText("Label") as HTMLInputElement).disabled).toBe(true);
  });
});
