/**
 * Tests for the global command palette (shortcuts, filtering, keyboard
 * navigation and opening the inspector drawer).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithRouter, stubMemoryStorage } from "./test-utils";
import { apiGetImpl } from "./inspectorFixtures";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    invalidate: vi.fn(),
  },
  API: "",
  _getAuthHeader: () => ({}),
  getStoredUser: () => null,
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  normPort: (p: string | null) => (p || "").trim().toLowerCase(),
}));

import CommandPalette from "../features/command-palette/CommandPalette";
import { usePaletteStore } from "../features/command-palette/paletteStore";
import { RECENT_STORAGE_KEY } from "../features/command-palette/recent";
import InspectorDrawer from "../features/inspector/InspectorDrawer";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{decodeURIComponent(location.pathname + location.search)}</div>;
}

function renderPalette(route = "/") {
  return renderWithRouter(
    <>
      <input aria-label="Page field" />
      <CommandPalette />
      <InspectorDrawer />
      <LocationProbe />
    </>,
    { route },
  );
}

const locationText = () => screen.getByTestId("location").textContent ?? "";

function pressCtrlK(target: Element | Document = document) {
  let notPrevented = true;
  act(() => {
    notPrevented = fireEvent.keyDown(target, { key: "k", ctrlKey: true });
  });
  return notPrevented;
}

function activeOptionText(input: HTMLElement): string {
  const id = input.getAttribute("aria-activedescendant");
  return (id && document.getElementById(id)?.textContent) || "";
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryStorage();
    usePaletteStore.setState({ open: false });
    mockApiGet.mockImplementation(apiGetImpl);
    mockApiPost.mockResolvedValue({ job_id: "job-1", status: "queued" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens on Ctrl+K, also from inside an input, and prevents the browser default", () => {
    renderPalette();
    expect(screen.queryByRole("combobox")).toBeNull();

    const field = screen.getByLabelText("Page field");
    field.focus();
    expect(pressCtrlK(field)).toBe(false);

    const input = screen.getByRole("combobox");
    expect(document.activeElement).toBe(input);
    // Empty query lists pages and actions.
    expect(screen.getByText("Pages")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.queryByText("Styleguide")).toBeNull();
  });

  it("opens with '/' only when not typing in an input", () => {
    renderPalette();
    const field = screen.getByLabelText("Page field");
    act(() => {
      fireEvent.keyDown(field, { key: "/" });
    });
    expect(screen.queryByRole("combobox")).toBeNull();

    act(() => {
      fireEvent.keyDown(document.body, { key: "/" });
    });
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("filters, navigates with the arrow keys and opens the inspector on Enter", async () => {
    renderPalette("/network?q=x");
    pressCtrlK();
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "core" } });
    await screen.findByText("Switches");
    expect(screen.queryByText("access-sw1")).toBeNull();
    expect(activeOptionText(input)).toContain("core-sw1");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeOptionText(input)).toContain("core-sw2");
    const active = document.getElementById(input.getAttribute("aria-activedescendant")!);
    expect(active?.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });

    // Palette closes, route stays, inspector opens for the selected switch.
    expect(screen.queryByRole("combobox")).toBeNull();
    await waitFor(() => expect(locationText()).toBe("/network?q=x&inspect=device:2"));
    expect(await screen.findByRole("dialog", { name: "core-sw2" })).toBeTruthy();
  });

  it("wraps arrow navigation and matches MACs without separators", async () => {
    renderPalette();
    pressCtrlK();
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "aabbccddee01" } });
    await screen.findByText("Endpoints");
    expect(activeOptionText(input)).toContain("printer-lobby");

    const optionCount = screen.getAllByRole("option").length;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(new RegExp(`-option-${optionCount - 1}$`));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-option-0$/);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(locationText()).toBe("/?inspect=endpoint:10"));
  });

  it("closes on Escape without closing an open inspector", async () => {
    renderPalette("/?inspect=device:1");
    await screen.findByRole("dialog", { name: "core-sw1" });
    pressCtrlK();
    const input = screen.getByRole("combobox");

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(locationText()).toBe("/?inspect=device:1");
  });

  it("navigates to pages and starts a scan from actions", async () => {
    renderPalette();
    pressCtrlK();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "start scan" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/scan/jobs"));
    expect(await screen.findByText("Scan started")).toBeTruthy();

    pressCtrlK();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "logs" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(locationText()).toBe("/logs"));
  });

  it("lists recently opened targets for an empty query", async () => {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(["rack:7", "device:999"]));
    renderPalette();
    pressCtrlK();

    expect(await screen.findByText("Recent")).toBeTruthy();
    expect(await screen.findByText("Rack A1")).toBeTruthy();
  });
});
