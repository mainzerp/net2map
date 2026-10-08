/**
 * Inspector "Latency" section: current values, status chip, the "all" mode
 * hint and the "Monitor latency" toggle sending the device meta update.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter, stubMemoryStorage } from "./test-utils";
import { apiGetImpl } from "./inspectorFixtures";

const mockApiGet = vi.fn();
const mockApiPatch = vi.fn();
const mockUser = vi.fn();
vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    delete: vi.fn(),
    invalidate: vi.fn(),
  },
  API: "",
  _getAuthHeader: () => ({}),
  getStoredUser: () => mockUser(),
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  normPort: (p: string | null) => (p || "").trim().toLowerCase(),
}));

import InspectorDrawer from "../features/inspector/InspectorDrawer";

const SUMMARY = {
  enabled: true,
  interval_sec: 10,
  mode: "all",
  monitor_alive: true,
  updated_at: "2026-10-08T08:00:00Z",
  network: { median_ms: 1, p95_ms: 3, loss_pct: 0, targets: 3, reachable: 3, degraded: 1 },
  devices: [
    {
      device_id: 1, name: "core-sw1", ip: "10.0.1.5", rtt_ms: 12.3, jitter_ms: 1.4, loss_pct: 0,
      baseline_ms: 2.1, status: "degraded", updated_at: null,
    },
  ],
};

function section() {
  return screen.getByRole("heading", { name: "Latency" }).closest("section") as HTMLElement;
}

describe("DeviceLatencySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryStorage();
    mockUser.mockReturnValue({ username: "admin", role: "admin" });
    mockApiPatch.mockResolvedValue({});
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/latency/summary") return Promise.resolve(SUMMARY);
      if (path.startsWith("/api/latency/history")) {
        return Promise.resolve({
          range: "1h",
          device_id: 1,
          bucket_sec: 60,
          points: [
            { ts: "a", rtt_ms: 2, jitter_ms: 0, loss_pct: 0 },
            { ts: "b", rtt_ms: 12, jitter_ms: 0, loss_pct: 0 },
          ],
        });
      }
      return apiGetImpl(path);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders current values, status and the device history", async () => {
    renderWithRouter(<InspectorDrawer />, { route: "/network?inspect=device:1" });
    await screen.findByRole("dialog", { name: "core-sw1" });
    await waitFor(() => expect(within(section()).getByText("12 ms")).toBeTruthy());
    const s = within(section());
    expect(s.getByText("1.4 ms")).toBeTruthy();
    expect(s.getByText("2.1 ms")).toBeTruthy();
    expect(s.getByTestId("latency-status").textContent).toBe("Degraded");
    expect(await s.findByRole("img", { name: /Round-trip time of core-sw1/ })).toBeTruthy();
    expect(mockApiGet).toHaveBeenCalledWith("/api/latency/history?range=1h&device_id=1");
    expect(s.getByText(/only matters in "selected devices" mode/)).toBeTruthy();
  });

  it("sends only latency_monitored through the device meta update", async () => {
    renderWithRouter(<InspectorDrawer />, { route: "/network?inspect=device:1" });
    await screen.findByRole("dialog", { name: "core-sw1" });
    const toggle = await within(section()).findByRole("checkbox", { name: "Monitor latency" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith("/api/topology/devices/1/meta", { latency_monitored: true }),
    );
  });

  it("keeps the pending toggle value until the topology refetch completes", async () => {
    renderWithRouter(<InspectorDrawer />, { route: "/network?inspect=device:1" });
    await screen.findByRole("dialog", { name: "core-sw1" });
    const toggle = (await within(section()).findByRole("checkbox", { name: "Monitor latency" })) as HTMLInputElement;

    // Hold the post-mutation topology refetch open.
    let releaseTopology: () => void = () => {};
    const baseGet = mockApiGet.getMockImplementation() as (path: string) => Promise<unknown>;
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") {
        return new Promise((resolve) => {
          releaseTopology = () => resolve(baseGet(path));
        });
      }
      return baseGet(path);
    });

    fireEvent.click(toggle);
    await waitFor(() => expect(mockApiPatch).toHaveBeenCalled());
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith("/api/topology"));
    // The fixture still says latency_monitored=false, but the refetch is pending:
    // the checkbox must not flip back yet.
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    releaseTopology();
    await waitFor(() => expect(toggle.disabled).toBe(false));
  });

  it("hides the toggle for viewers", async () => {
    mockUser.mockReturnValue({ username: "v", role: "viewer" });
    renderWithRouter(<InspectorDrawer />, { route: "/network?inspect=device:1" });
    await screen.findByRole("dialog", { name: "core-sw1" });
    await waitFor(() => expect(within(section()).getByText("12 ms")).toBeTruthy());
    expect(within(section()).queryByRole("checkbox")).toBeNull();
  });
});
