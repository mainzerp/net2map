/**
 * Tests for EndpointTable component.
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

import EndpointTable from "../components/EndpointTable";

describe("EndpointTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders endpoint rows from API data", async () => {
    const endpoints = [
      { id: 1, mac: "aa:bb:cc:dd:ee:01", ip: "10.0.0.100", hostname: "pc1", ignored: false, first_seen: null, last_seen: null, notes: null, found_on: [] },
      { id: 2, mac: "aa:bb:cc:dd:ee:02", ip: "10.0.0.101", hostname: "pc2", ignored: false, first_seen: null, last_seen: null, notes: null, found_on: [] },
    ];

    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/endpoints") return Promise.resolve(endpoints);
      return Promise.resolve([]);
    });

    renderWithRouter(<EndpointTable />);

    await waitFor(() => {
      expect(screen.getByText("aa:bb:cc:dd:ee:01")).toBeTruthy();
      expect(screen.getByText("aa:bb:cc:dd:ee:02")).toBeTruthy();
    });

    expect(screen.getByText("10.0.0.100")).toBeTruthy();
    expect(screen.getByText("10.0.0.101")).toBeTruthy();
  });

  it("shows empty message when no endpoints", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/endpoints") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderWithRouter(<EndpointTable />);

    await waitFor(() => {
      expect(screen.getByText("No endpoint devices discovered yet")).toBeTruthy();
    });
  });

  it("renders hostname column", async () => {
    const endpoints = [
      { id: 1, mac: "aa:bb:cc:dd:ee:03", ip: "10.0.0.102", hostname: "workstation-1", ignored: false, first_seen: null, last_seen: null, notes: null, found_on: [] },
    ];

    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/endpoints") return Promise.resolve(endpoints);
      return Promise.resolve([]);
    });

    renderWithRouter(<EndpointTable />);

    await waitFor(() => {
      expect(screen.getByText("workstation-1")).toBeTruthy();
    });
  });

  it("renders found_on port info", async () => {
    const endpoints = [
      {
        id: 1, mac: "aa:bb:cc:dd:ee:04", ip: "10.0.0.103", hostname: null,
        ignored: false, first_seen: null, last_seen: null, notes: null,
        found_on: [{
          port_id: 1, switch_ip: "10.0.0.1", switch_name: "core-sw",
          port_name: "eth0", vlan_id: 100, last_seen: null,
        }],
      },
    ];

    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/endpoints") return Promise.resolve(endpoints);
      return Promise.resolve([]);
    });

    renderWithRouter(<EndpointTable />);

    await waitFor(() => {
      expect(screen.getByText("core-sw:eth0")).toBeTruthy();
    });
  });

  it("prefills the search from the ?q= query param", async () => {
    const endpoints = [
      { id: 1, mac: "aa:bb:cc:dd:ee:05", ip: "10.0.0.104", hostname: "printer-1", ignored: false, first_seen: null, last_seen: null, notes: null, found_on: [] },
      { id: 2, mac: "aa:bb:cc:dd:ee:06", ip: "10.0.0.105", hostname: "laptop-1", ignored: false, first_seen: null, last_seen: null, notes: null, found_on: [] },
    ];

    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/endpoints") return Promise.resolve(endpoints);
      return Promise.resolve([]);
    });

    renderWithRouter(<EndpointTable />, { route: "/devices?q=printer" });

    await waitFor(() => {
      expect(screen.getByText("printer-1")).toBeTruthy();
    });

    expect(screen.queryByText("laptop-1")).toBeNull();
  });

  it("shows an error state with retry when the fetch fails", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/endpoints") return Promise.reject(new Error("boom"));
      return Promise.resolve([]);
    });

    renderWithRouter(<EndpointTable />);

    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeTruthy();
    });
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});
