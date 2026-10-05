/**
 * Tests for DashboardPage component.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

// Mock useScanProgress hook
vi.mock("../hooks/useScanProgress", () => ({
  useScanProgress: () => null,
}));

// Mock the store
vi.mock("../store", () => {
  const store = () => null;
  store.getState = () => ({});
  return { default: store };
});

// Mock api module
const mockApiGet = vi.fn();
vi.mock("../api", () => ({
  api: { get: (...args: unknown[]) => mockApiGet(...args) },
  API: "",
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
}));

// Must import after mocks are set up
import DashboardPage from "../pages/DashboardPage";

const topoData = {
  nodes: [
    {
      id: 1, ip: "10.0.0.1", sys_name: "switch-1", hostname: "switch-1", vendor: "aruba_cx",
      rack_id: 1, ignored: false, ping_status: "online",
      ports: [{ oper_status: 1 }, { oper_status: 2 }],
    },
    {
      id: 2, ip: "10.0.0.2", sys_name: "switch-2", hostname: "switch-2", vendor: "generic",
      rack_id: 1, ignored: false, ping_status: "offline", last_seen: "2026-01-01T10:00:00Z",
      ports: [{ oper_status: 1 }],
    },
  ],
  links: [{ speed_label: "1G" }],
  racks: [{ id: 1, label: "Rack-A", location: "Room 1", room: "Room 1" }],
  classes: [],
  models: [],
};

const statsData = {
  device_count: 2,
  port_count: 3,
  port_up_count: 2,
  rack_count: 1,
};

function mockApiSuccess() {
  mockApiGet.mockImplementation((path: string) => {
    if (path === "/api/topology") return Promise.resolve(topoData);
    if (path === "/api/stats") return Promise.resolve(statsData);
    if (path === "/api/endpoints") return Promise.resolve([]);
    if (path.startsWith("/api/scan-runs")) return Promise.resolve([]);
    return Promise.resolve({});
  });
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading skeleton initially", () => {
    // Make api.get return a promise that never resolves
    mockApiGet.mockReturnValue(new Promise(() => {}));
    renderWithRouter(<DashboardPage />);
    expect(screen.getByLabelText("Loading dashboard")).toBeTruthy();
  });

  it("renders stats after data loads", async () => {
    mockApiSuccess();
    renderWithRouter(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Dashboard")).toBeTruthy();
    });

    // Headline status sentence derived from the data (1 online, 1 offline)
    const headline = screen.getByRole("heading", { level: 1 });
    expect(headline.textContent).toBe("1 switch online. 1 needs attention.");

    // Secondary fact line renders the key counts as deep links
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "0 endpoints" })).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: "2 devices" }).getAttribute("href")).toBe("/network");
    expect(screen.getByRole("link", { name: "1 link" }).getAttribute("href")).toBe("/map");
    expect(screen.getByRole("link", { name: "2/3 ports up" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "1 rack" })).toBeTruthy();

    // Single primary action and the composition panel
    expect(screen.getByRole("button", { name: "Start scan" })).toBeTruthy();
    expect(screen.getByText("Composition")).toBeTruthy();

    // Rack overview renders the rack label
    expect(screen.getByText("Rack-A")).toBeTruthy();
  });

  it("shows the all-online headline and empty attention state", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") {
        return Promise.resolve({
          ...topoData,
          nodes: topoData.nodes.map((n) => ({ ...n, ping_status: "online" })),
        });
      }
      if (path === "/api/stats") return Promise.resolve(statsData);
      if (path === "/api/endpoints") return Promise.resolve([]);
      if (path.startsWith("/api/scan-runs")) return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderWithRouter(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("All 2 switches online.");
    });
    expect(screen.getByText("All devices reachable")).toBeTruthy();
  });

  it("lists offline devices in the attention card", async () => {
    mockApiSuccess();
    renderWithRouter(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Attention needed")).toBeTruthy();
    });

    // switch-2 is offline and shows up with an icon+word status chip
    expect(screen.getByText("switch-2")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
  });

  it("shows error state with retry when the topology fetch fails", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") return Promise.reject(new Error("Network error"));
      if (path === "/api/stats") return Promise.resolve(statsData);
      if (path === "/api/endpoints") return Promise.resolve([]);
      if (path.startsWith("/api/scan-runs")) return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderWithRouter(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeTruthy();
    });
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});
