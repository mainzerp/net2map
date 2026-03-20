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
  VENDOR_LABEL: {},
  VENDOR_COLOR: {},
  VENDOR_ICON: {},
}));

// Must import after mocks are set up
import DashboardPage from "../pages/DashboardPage";

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    // Make api.get return a promise that never resolves
    mockApiGet.mockReturnValue(new Promise(() => {}));
    renderWithRouter(<DashboardPage />);
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("renders stats after data loads", async () => {
    const topoData = {
      nodes: [
        { ip: "10.0.0.1", sys_name: "switch-1", vendor: "aruba_cx", rack_id: 1, ports: [{ oper_status: 1 }, { oper_status: 2 }] },
        { ip: "10.0.0.2", sys_name: "switch-2", vendor: "generic", rack_id: 1, ports: [{ oper_status: 1 }] },
      ],
      links: [{ speed_label: "1G" }],
      racks: [{ id: 1, label: "Rack-A", location: "Room 1" }],
      classes: [],
      models: [],
    };
    const statsData = {
      device_count: 2,
      port_count: 3,
      port_up_count: 2,
      rack_count: 1,
    };

    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") return Promise.resolve(topoData);
      if (path === "/api/stats") return Promise.resolve(statsData);
      return Promise.resolve({});
    });

    renderWithRouter(<DashboardPage />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    // Verify the Dashboard title renders
    expect(screen.getByText("Dashboard")).toBeTruthy();

    // Verify device count is displayed (may appear in multiple stat cards)
    const allTwos = screen.getAllByText("2");
    expect(allTwos.length).toBeGreaterThan(0);
  });

  it("shows error state when fetch fails", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") return Promise.reject(new Error("Network error"));
      if (path === "/api/stats") return Promise.resolve(null);
      return Promise.resolve({});
    });

    renderWithRouter(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeTruthy();
    });
  });
});
