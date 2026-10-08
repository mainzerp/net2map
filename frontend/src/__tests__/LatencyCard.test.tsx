/**
 * Dashboard latency card: disabled, monitor-not-alive, no-data, error and
 * data states, plus opening the inspector from a degraded device row.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithRouter, type createApiMock } from "./test-utils";
import type { LatencySummary } from "../types";

const holder = vi.hoisted(() => ({ api: null as null | ReturnType<typeof createApiMock> }));
vi.mock("../api", async () => {
  const utils = await import("./test-utils");
  holder.api = utils.createApiMock();
  return {
    api: holder.api,
    API: "",
    extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  };
});

import { LatencyCard } from "../features/latency/LatencyCard";

function summary(extra: Partial<LatencySummary> = {}): LatencySummary {
  return {
    enabled: true,
    interval_sec: 10,
    mode: "all",
    monitor_alive: true,
    updated_at: new Date().toISOString(),
    network: { median_ms: 0.8, p95_ms: 4.2, loss_pct: 0.5, targets: 4, reachable: 3, degraded: 1 },
    devices: [
      { device_id: 3, name: "edge-sw3", ip: "10.0.0.3", rtt_ms: null, jitter_ms: null, loss_pct: 100, baseline_ms: 1, status: "down", updated_at: null },
      { device_id: 2, name: "core-sw2", ip: "10.0.0.2", rtt_ms: 25, jitter_ms: 3, loss_pct: 0, baseline_ms: 2, status: "degraded", updated_at: null },
      { device_id: 1, name: "core-sw1", ip: "10.0.0.1", rtt_ms: 0.6, jitter_ms: 0.1, loss_pct: 0, baseline_ms: 0.5, status: "ok", updated_at: null },
    ],
    ...extra,
  };
}

function mockGet(data: unknown) {
  holder.api!.get.mockImplementation((path: string) => {
    if (path === "/api/latency/summary") return Promise.resolve(data);
    if (path.startsWith("/api/latency/history")) {
      return Promise.resolve({
        range: "1h",
        device_id: null,
        bucket_sec: 60,
        points: [
          { ts: "2026-10-08T08:00:00Z", rtt_ms: 0.7, jitter_ms: 0.1, loss_pct: 0 },
          { ts: "2026-10-08T08:01:00Z", rtt_ms: 0.9, jitter_ms: 0.1, loss_pct: 0 },
        ],
      });
    }
    return Promise.resolve({});
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{decodeURIComponent(location.pathname + location.search)}</div>;
}

describe("LatencyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a settings hint when the monitor is disabled", async () => {
    mockGet(summary({ enabled: false }));
    renderWithRouter(<LatencyCard />);
    expect(await screen.findByText("The latency monitor is disabled.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Enable it in Settings" });
    expect(link.getAttribute("href")).toBe("/settings/scan");
  });

  it("warns when the latency-monitor service is not running", async () => {
    mockGet(summary({ monitor_alive: false }));
    renderWithRouter(<LatencyCard />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("latency-monitor service is not running");
  });

  it("shows a no-data state before the first round", async () => {
    mockGet(
      summary({
        updated_at: null,
        network: { median_ms: null, p95_ms: null, loss_pct: null, targets: 0, reachable: 0, degraded: 0 },
        devices: [],
      }),
    );
    renderWithRouter(<LatencyCard />);
    expect(await screen.findByText(/No latency data yet/)).toBeTruthy();
  });

  it("shows an error state when the summary fails", async () => {
    holder.api!.get.mockRejectedValue(new Error("HTTP 500: boom"));
    renderWithRouter(<LatencyCard />);
    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 500: boom");
  });

  it("renders network stats, the trend and problem devices that open the inspector", async () => {
    mockGet(summary());
    renderWithRouter(
      <>
        <LatencyCard />
        <LocationProbe />
      </>,
    );
    expect(await screen.findByText("0.8 ms")).toBeTruthy();
    expect(screen.getByText("4.2 ms")).toBeTruthy();
    expect(screen.getByText("0.5 %")).toBeTruthy();
    expect(screen.getByText("3/4")).toBeTruthy();
    expect(await screen.findByRole("img", { name: /Network median latency/ })).toBeTruthy();

    const list = screen.getByRole("list", { name: "Devices with latency issues" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(screen.queryByText("core-sw1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Open details for core-sw2/ }));
    expect(screen.getByTestId("location").textContent).toBe("/?inspect=device:2");

    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    expect(holder.api!.get).toHaveBeenCalledWith("/api/latency/history?range=24h");
  });
});
