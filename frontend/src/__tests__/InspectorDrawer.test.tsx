/**
 * Tests for the URL-driven inspector drawer (useInspector + InspectorDrawer).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithRouter, stubMemoryStorage } from "./test-utils";
import { apiGetImpl } from "./inspectorFixtures";

const mockApiGet = vi.fn();
vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    invalidate: vi.fn(),
  },
  API: "",
  _getAuthHeader: () => ({}),
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  normPort: (p: string | null) => (p || "").trim().toLowerCase(),
}));

import InspectorDrawer from "../features/inspector/InspectorDrawer";
import { parseInspectParam } from "../hooks/useInspector";
import { RECENT_STORAGE_KEY } from "../features/command-palette/recent";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{decodeURIComponent(location.pathname + location.search)}</div>;
}

function renderDrawer(route: string) {
  return renderWithRouter(
    <>
      <InspectorDrawer />
      <LocationProbe />
    </>,
    { route },
  );
}

const locationText = () => screen.getByTestId("location").textContent ?? "";

describe("parseInspectParam", () => {
  it("parses valid targets and rejects malformed ones", () => {
    expect(parseInspectParam("device:12")).toEqual({ kind: "device", id: 12 });
    expect(parseInspectParam("rack:3")).toEqual({ kind: "rack", id: 3 });
    expect(parseInspectParam("endpoint:x")).toBeNull();
    expect(parseInspectParam("port:1")).toBeNull();
    expect(parseInspectParam(null)).toBeNull();
  });
});

describe("InspectorDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryStorage();
    mockApiGet.mockImplementation(apiGetImpl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the device view for ?inspect=device:<id>", async () => {
    renderDrawer("/network?inspect=device:1");

    const dialog = await screen.findByRole("dialog", { name: "core-sw1" });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(screen.getByText("10.0.1.5")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("1 up")).toBeTruthy();
    // Neighbor from the topology link, and the rack cross link.
    expect(screen.getByRole("button", { name: "core-sw2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rack A1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show on map/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open rack/ })).toBeTruthy();
    // Focus moves into the drawer on open.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and removes only the inspect param", async () => {
    renderDrawer("/network?q=core&inspect=device:1");
    await screen.findByRole("dialog", { name: "core-sw1" });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(locationText()).toBe("/network?q=core"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navigates between targets via cross links", async () => {
    renderDrawer("/?inspect=device:1");
    fireEvent.click(await screen.findByRole("button", { name: "Rack A1" }));

    await screen.findByRole("dialog", { name: "Rack A1" });
    expect(locationText()).toBe("/?inspect=rack:7");
    // The rack lists its devices; clicking one opens its device view.
    fireEvent.click(screen.getByRole("button", { name: /core-sw2/ }));
    await screen.findByRole("dialog", { name: "core-sw2" });
  });

  it("renders the endpoint view and links the switch it was seen on", async () => {
    renderDrawer("/devices?inspect=endpoint:10");

    await screen.findByRole("dialog", { name: "printer-lobby" });
    expect(screen.getByText("Front desk printer")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Go to port/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "core-sw1" }));
    await screen.findByRole("dialog", { name: "core-sw1" });
    expect(locationText()).toBe("/devices?inspect=device:1");
  });

  it("shows a friendly empty state for unknown ids", async () => {
    renderDrawer("/?inspect=device:999");

    expect(await screen.findByRole("dialog", { name: "Switch not found" })).toBeTruthy();
    expect(screen.getByText("It may have been removed or the link is out of date.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(locationText()).toBe("/"));
  });

  it("records opened targets for the palette recent list", async () => {
    renderDrawer("/?inspect=rack:7");
    await screen.findByRole("dialog", { name: "Rack A1" });
    expect(JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || "[]")).toEqual(["rack:7"]);
  });
});
