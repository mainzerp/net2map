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

const defaultProps = {
  title: "Network Devices",
  subtitle: "Managed switches",
  activeLabel: "Active",
  ignoredLabel: "Ignored",
  emptyMessage: "No devices found",
};

const devices = [
  {
    id: 1, sys_name: "core-sw-01", ip: "10.0.0.1", mac: "aa:bb:cc:00:00:01", vendor: "aruba_cx",
    ignored: false, ports: [], rack_id: null, class_id: null, model_id: null,
    ping_status: "online", location: "DC-1", last_seen: "2026-01-01T10:00:00Z",
  },
  {
    id: 2, sys_name: "access-sw-02", ip: "10.0.0.2", mac: "aa:bb:cc:00:00:02", vendor: "generic",
    ignored: false, ports: [], rack_id: null, class_id: null, model_id: null,
    ping_status: "offline", location: "", last_seen: "2026-01-01T09:00:00Z",
  },
];

function mockApiSuccess(deviceList: unknown[] = devices) {
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith("/api/devices")) return Promise.resolve(deviceList);
    if (path === "/api/racks") return Promise.resolve([]);
    if (path === "/api/switch-classes") return Promise.resolve([]);
    if (path === "/api/switch-models") return Promise.resolve([]);
    return Promise.resolve([]);
  });
}

describe("DeviceTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders device rows from API data", async () => {
    mockApiSuccess();

    renderWithRouter(<DeviceTable {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("core-sw-01")).toBeTruthy();
      expect(screen.getByText("access-sw-02")).toBeTruthy();
    });

    // Verify IPs render
    expect(screen.getByText("10.0.0.1")).toBeTruthy();
    expect(screen.getByText("10.0.0.2")).toBeTruthy();

    // New columns render
    expect(screen.getByText("DC-1")).toBeTruthy();
    expect(screen.getByText("online")).toBeTruthy();
    expect(screen.getByText("offline")).toBeTruthy();
  });

  it("shows empty message when no devices", async () => {
    mockApiSuccess([]);

    renderWithRouter(<DeviceTable {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("No devices found")).toBeTruthy();
    });
  });

  it("applies the status filter from the ?status=down deep link", async () => {
    mockApiSuccess();

    renderWithRouter(<DeviceTable {...defaultProps} />, { route: "/network?status=down" });

    await waitFor(() => {
      expect(screen.getByText("access-sw-02")).toBeTruthy();
    });

    // The online device is filtered out
    expect(screen.queryByText("core-sw-01")).toBeNull();
  });

  it("prefills the search from the ?q= query param", async () => {
    mockApiSuccess();

    renderWithRouter(<DeviceTable {...defaultProps} />, { route: "/network?q=core" });

    await waitFor(() => {
      expect(screen.getByText("core-sw-01")).toBeTruthy();
    });

    expect(screen.queryByText("access-sw-02")).toBeNull();
    expect(screen.getByDisplayValue("core")).toBeTruthy();
  });

  it("shows an error state with retry when the fetch fails", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path.startsWith("/api/devices")) return Promise.reject(new Error("boom"));
      return Promise.resolve([]);
    });

    renderWithRouter(<DeviceTable {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeTruthy();
    });
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});
