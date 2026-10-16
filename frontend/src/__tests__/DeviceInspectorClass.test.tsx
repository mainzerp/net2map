/**
 * Device inspector details: the SNMP model string is labelled "Reported
 * model"; class (with color swatch) and hardware model come from the
 * topology payload and read "none" when unset.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter, stubMemoryStorage } from "./test-utils";
import { TOPOLOGY, apiGetImpl } from "./inspectorFixtures";
import type { TopologyData } from "../types";

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
  getStoredUser: () => null,
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  normPort: (p: string | null) => (p || "").trim().toLowerCase(),
}));

import InspectorDrawer from "../features/inspector/InspectorDrawer";

const CLASSED: TopologyData = {
  ...TOPOLOGY,
  classes: [{ id: 3, label: "Core", color: "#00aa00", allow_outside_rack: false }],
  models: [{ id: 8, name: "CX 6300 48G", ports_per_row: 24, total_ports: 52 }],
  nodes: TOPOLOGY.nodes.map(n => (n.id === 1 ? { ...n, model: "JL668A", class_id: 3, model_id: 8 } : n)),
};

describe("DeviceInspector class and hardware model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryStorage();
    mockApiGet.mockImplementation((path: string) =>
      path === "/api/topology" ? Promise.resolve(CLASSED) : apiGetImpl(path),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows reported model, class and hardware model", async () => {
    renderWithRouter(<InspectorDrawer />, { route: "/?inspect=device:1" });
    await screen.findByRole("dialog", { name: "core-sw1" });
    expect(screen.getByText("Reported model").nextElementSibling?.textContent).toBe("JL668A");
    expect(screen.getByText("Class").nextElementSibling?.textContent).toBe("Core");
    expect(screen.getByTestId("device-class")).toBeTruthy();
    expect(screen.getByText("Hardware model").nextElementSibling?.textContent).toBe("CX 6300 48G");
  });

  it("reads none without class or hardware model", async () => {
    renderWithRouter(<InspectorDrawer />, { route: "/?inspect=device:2" });
    await screen.findByRole("dialog", { name: "core-sw2" });
    expect(screen.getByText("Class").nextElementSibling?.textContent).toBe("none");
    expect(screen.getByText("Hardware model").nextElementSibling?.textContent).toBe("none");
  });
});
