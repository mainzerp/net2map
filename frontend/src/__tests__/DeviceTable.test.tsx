/**
 * Tests for DeviceTable component.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

// Mock the store
vi.mock("../store", () => {
  const store = () => vi.fn();
  store.getState = () => ({});
  return { default: store };
});

// Mock api module
const mockApiGet = vi.fn();
vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    patch: vi.fn(),
    invalidate: vi.fn(),
  },
  API: "",
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  normPort: (p: string | null) => (p || "").trim().toLowerCase(),
}));

import DeviceTable from "../components/DeviceTable";

describe("DeviceTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders device rows from API data", async () => {
    const devices = [
      { id: 1, sys_name: "core-sw-01", ip: "10.0.0.1", vendor: "aruba_cx", ignored: false, ports: [], rack_id: null, class_id: null, model_id: null },
      { id: 2, sys_name: "access-sw-02", ip: "10.0.0.2", vendor: "generic", ignored: false, ports: [], rack_id: null, class_id: null, model_id: null },
    ];

    mockApiGet.mockImplementation((path: string) => {
      if (path.startsWith("/api/devices")) return Promise.resolve(devices);
      if (path === "/api/racks") return Promise.resolve([]);
      if (path === "/api/switch-classes") return Promise.resolve([]);
      if (path === "/api/switch-models") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderWithRouter(
      <DeviceTable
        title="Network Devices"
        subtitle="Managed switches"
        activeLabel="Active"
        ignoredLabel="Ignored"
        emptyMessage="No devices"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("core-sw-01")).toBeTruthy();
      expect(screen.getByText("access-sw-02")).toBeTruthy();
    });

    // Verify IPs render
    expect(screen.getByText("10.0.0.1")).toBeTruthy();
    expect(screen.getByText("10.0.0.2")).toBeTruthy();
  });

  it("shows empty message when no devices", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path.startsWith("/api/devices")) return Promise.resolve([]);
      if (path === "/api/racks") return Promise.resolve([]);
      if (path === "/api/switch-classes") return Promise.resolve([]);
      if (path === "/api/switch-models") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderWithRouter(
      <DeviceTable
        title="Network Devices"
        subtitle="Managed switches"
        activeLabel="Active"
        ignoredLabel="Ignored"
        emptyMessage="No devices found"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No devices found")).toBeTruthy();
    });
  });
});
