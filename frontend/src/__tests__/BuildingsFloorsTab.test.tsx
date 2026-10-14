/**
 * Settings > Buildings & floors: CRUD calls for buildings and floors,
 * reordering, delete confirmation, per-floor background settings and upload,
 * and read-only rendering for viewers.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";
import type { Building } from "../types";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPatch = vi.fn();
const mockApiDel = vi.fn();
const mockApiUpload = vi.fn();
let mockRole = "admin";

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: vi.fn(),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    del: (...args: unknown[]) => mockApiDel(...args),
    upload: (...args: unknown[]) => mockApiUpload(...args),
    invalidate: vi.fn(),
  },
  API: "",
  apiUrl: (path: string) => path,
  _getAuthHeader: () => ({ Authorization: "Bearer t" }),
  getStoredUser: () => ({ username: "u", role: mockRole }),
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
}));

import BuildingsFloorsTabContent from "../components/settings/BuildingsFloorsTab";

function floor(id: number, label: string, sortOrder: number, hasBackground = false) {
  return {
    id,
    building_id: 1,
    label,
    sort_order: sortOrder,
    has_background: hasBackground,
    bg_version: 2,
    bg_opacity: 0.3,
    bg_scale: 1,
    bg_color: "#020817",
  };
}

const BUILDINGS: Building[] = [
  {
    id: 1,
    label: "Main",
    description: null,
    sort_order: 0,
    floors: [floor(10, "Ground", 0, true), floor(11, "First", 1)],
  },
];

describe("BuildingsFloorsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole = "admin";
    mockApiGet.mockImplementation((path: string) =>
      Promise.resolve(path === "/api/buildings" ? BUILDINGS : []),
    );
    mockApiPost.mockResolvedValue({});
    mockApiPatch.mockResolvedValue({});
    mockApiDel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a building and a floor with the next sort order", async () => {
    renderWithRouter(<BuildingsFloorsTabContent />);
    await screen.findByDisplayValue("Main");

    fireEvent.change(screen.getByLabelText("New building name"), { target: { value: "Annex" } });
    fireEvent.click(screen.getByRole("button", { name: "Add building" }));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/buildings", { label: "Annex", sort_order: 1 }),
    );

    fireEvent.change(screen.getByLabelText("New floor name for Main"), { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Add floor" }));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/buildings/1/floors", { label: "Second", sort_order: 2 }),
    );
  });

  it("renames and reorders floors", async () => {
    renderWithRouter(<BuildingsFloorsTabContent />);
    const ground = await screen.findByLabelText("Floor name for Ground");
    fireEvent.change(ground, { target: { value: "Lobby" } });
    fireEvent.blur(ground);
    await waitFor(() => expect(mockApiPatch).toHaveBeenCalledWith("/api/floors/10", { label: "Lobby" }));

    fireEvent.click(screen.getByRole("button", { name: "Move Ground down" }));
    await waitFor(() => {
      expect(mockApiPatch).toHaveBeenCalledWith("/api/floors/11", { sort_order: 0 });
      expect(mockApiPatch).toHaveBeenCalledWith("/api/floors/10", { sort_order: 1 });
    });
  });

  it("confirms floor deletion and explains that assignments are cleared", async () => {
    renderWithRouter(<BuildingsFloorsTabContent />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete floor First" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/become unassigned/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockApiDel).toHaveBeenCalledWith("/api/floors/11"));
  });

  it("saves floor background settings and uploads a floor plan", async () => {
    mockApiUpload.mockResolvedValue(floor(11, "First", 1, true));
    renderWithRouter(<BuildingsFloorsTabContent />);
    await screen.findByDisplayValue("Ground");

    // Ground has a floor plan: preview uses the public, versioned URL.
    fireEvent.click(screen.getAllByRole("button", { name: "Background" })[0]);
    const panel = await screen.findByTestId("floor-bg-10");
    expect(within(panel).getByRole("img").getAttribute("src")).toBe("/api/floors/10/background?v=2");
    fireEvent.change(within(panel).getByLabelText("Background opacity for Ground"), { target: { value: "0.6" } });
    await waitFor(() => expect(mockApiPatch).toHaveBeenCalledWith("/api/floors/10", { bg_opacity: 0.6 }), {
      timeout: 2000,
    });

    // First has none: upload posts multipart to the floor endpoint.
    fireEvent.click(screen.getAllByRole("button", { name: "Background" })[1]);
    const firstPanel = await screen.findByTestId("floor-bg-11");
    const file = new File(["png"], "plan.png", { type: "image/png" });
    fireEvent.change(within(firstPanel).getByLabelText("Background image for First"), { target: { files: [file] } });
    await waitFor(() => expect(mockApiUpload).toHaveBeenCalled());
    const [url, body] = mockApiUpload.mock.calls[0];
    expect(url).toBe("/api/floors/11/background");
    expect((body as FormData).get("file")).toBe(file);
  });

  it("deletes a building after confirmation", async () => {
    renderWithRouter(<BuildingsFloorsTabContent />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete building Main" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockApiDel).toHaveBeenCalledWith("/api/buildings/1"));
  });

  it("is read-only for viewers", async () => {
    mockRole = "viewer";
    renderWithRouter(<BuildingsFloorsTabContent />);
    await screen.findByDisplayValue("Main");
    expect(screen.queryByLabelText("New building name")).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete floor/ })).toBeNull();
    expect((screen.getByLabelText("Floor name for Ground") as HTMLInputElement).disabled).toBe(true);
  });
});
