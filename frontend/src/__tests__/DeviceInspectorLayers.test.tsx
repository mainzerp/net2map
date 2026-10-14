/**
 * Device inspector: VLAN / STP port columns and the spanning tree summary
 * appear only when the device reports that data.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within } from "@testing-library/react";
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

// core-sw1 (id 1) gets STP data and tagged VLANs; core-sw2 (id 2) loses all
// VLAN data and has no STP.
const LAYERED: TopologyData = {
  ...TOPOLOGY,
  nodes: TOPOLOGY.nodes.map(n => {
    if (n.id === 1) {
      return {
        ...n,
        stp: { protocol: "rstp", bridge_id: "8000.aa", root_id: "8000.aa", root_cost: 0, root_port: null, is_root: true },
        ports: n.ports.map((p, i) =>
          i === 0
            ? { ...p, vlan: 20, tagged_vlans: [30, 40, 50], stp_role: "designated", stp_state: "forwarding", stp_path_cost: 2000 }
            : { ...p, stp_role: "blocked", stp_state: "blocking" },
        ),
      };
    }
    if (n.id === 2) {
      return { ...n, ports: n.ports.map(p => ({ ...p, vlan: null, tagged_vlans: [] })) };
    }
    return n;
  }),
};

function headers(): string[] {
  const table = screen.getByRole("table");
  return within(table).getAllByRole("columnheader").map(h => h.textContent ?? "");
}

describe("DeviceInspector logical layer data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryStorage();
    mockApiGet.mockImplementation((path: string) =>
      path === "/api/topology" ? Promise.resolve(LAYERED) : apiGetImpl(path),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows VLAN and STP columns plus the STP summary when data exists", async () => {
    renderWithRouter(<InspectorDrawer />, { route: "/?inspect=device:1" });
    await screen.findByRole("dialog", { name: "core-sw1" });
    expect(headers()).toEqual(["Port", "Status", "Speed", "VLAN", "STP", "Endp."]);
    const vlanCell = screen.getByText("20 + 3 tagged");
    expect(vlanCell.getAttribute("title")).toBe("Tagged: 30, 40, 50");
    expect(screen.getByText("designated").getAttribute("title")).toBe("Role: designated, State: forwarding, Path cost: 2000");
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(screen.getByText("Spanning tree")).toBeTruthy();
    expect(screen.getByText("RSTP")).toBeTruthy();
    expect(screen.getByText("Root bridge").nextElementSibling?.textContent).toBe("Yes");
  });

  it("hides the VLAN and STP columns and the summary without data", async () => {
    renderWithRouter(<InspectorDrawer />, { route: "/?inspect=device:2" });
    await screen.findByRole("dialog", { name: "core-sw2" });
    expect(headers()).toEqual(["Port", "Status", "Speed", "Endp."]);
    expect(screen.queryByText("Spanning tree")).toBeNull();
  });
});

describe("DeviceInspector ping-only devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryStorage();
    const pingOnly: TopologyData = {
      ...TOPOLOGY,
      nodes: TOPOLOGY.nodes.map(n => (n.id === 2 ? { ...n, ping_only: true, device_type: "other", ports: [] } : n)),
    };
    mockApiGet.mockImplementation((path: string) =>
      path === "/api/topology" ? Promise.resolve(pingOnly) : apiGetImpl(path),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the Ping only badge and the generic type, and skips the empty ports section", async () => {
    renderWithRouter(<InspectorDrawer />, { route: "/?inspect=device:2" });
    await screen.findByRole("dialog", { name: "core-sw2" });
    expect(screen.getByTestId("ping-only").textContent).toBe("Ping only");
    expect(screen.getByTestId("device-type").textContent).toBe("Other device");
    expect(screen.queryByText("No ports recorded")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
