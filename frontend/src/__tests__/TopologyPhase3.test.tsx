/**
 * Tests for the topology map phase 3: vendor badges and speed stroke widths
 * (theme/visual.ts), the semantic zoom tier helper, link status derivation,
 * the flow-toggle default, and the inspector "Show on map" focus action.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithRouter, stubMemoryStorage } from "./test-utils";
import { apiGetImpl } from "./inspectorFixtures";

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
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  normPort: (p: string | null) => (p || "").trim().toLowerCase(),
}));

import InspectorDrawer from "../features/inspector/InspectorDrawer";
import useNet2MapStore from "../store";
import {
  VENDOR_BADGE,
  VENDOR_COLOR,
  vendorBadge,
  speedStrokeWidth,
  speedLabelToMbps,
} from "../theme/visual";
import { zoomTier, ZOOM_TIER_FAR_BELOW, ZOOM_TIER_CLOSE_ABOVE } from "../features/topology/zoomTier";
import { defaultFlowEnabled, FLOW_DEFAULT_EDGE_LIMIT } from "../features/topology/flowContext";
import { linkStatus, aggregateLinkStatus } from "../features/topology/graph";
import VendorBadge from "../components/map/VendorBadge";
import type { TopologyLink, TopologyNode } from "../types";

describe("VENDOR_BADGE / vendorBadge", () => {
  it("maps known vendors to short readable labels in their vendor color", () => {
    expect(VENDOR_BADGE.aruba_cx).toEqual({ short: "Aruba", name: "Aruba CX", color: VENDOR_COLOR.aruba_cx });
    expect(vendorBadge("fs").short).toBe("FS");
    expect(vendorBadge("unifi").short).toBe("UniFi");
    expect(vendorBadge("opnsense").short).toBe("OPN");
    expect(vendorBadge("generic").short).toBe("Gen");
  });

  it("falls back for missing and unknown vendors", () => {
    expect(vendorBadge(undefined)).toBe(VENDOR_BADGE.generic);
    expect(vendorBadge("")).toBe(VENDOR_BADGE.generic);
    const cisco = vendorBadge("cisco");
    expect(cisco.short).toBe("CIS");
    expect(cisco.name).toBe("cisco");
  });

  it("renders a pill with text-primary label, vendor border and full name tooltip", () => {
    render(<VendorBadge vendor="aruba_cx" />);
    const badge = screen.getByTitle("Aruba CX");
    expect(badge.textContent).toBe("Aruba");
    expect(badge.className).toContain("rounded-full");
    expect(badge.className).toContain("text-primary");
    expect(badge.textContent).not.toMatch(/\[/);
  });
});

describe("speedStrokeWidth", () => {
  it("encodes link speed as ink weight", () => {
    expect(speedStrokeWidth(0)).toBe(1);
    expect(speedStrokeWidth(10)).toBe(1);
    expect(speedStrokeWidth(100)).toBe(1);
    expect(speedStrokeWidth(1000)).toBe(1.5);
    expect(speedStrokeWidth(10000)).toBe(2.25);
    expect(speedStrokeWidth(25000)).toBe(3);
    expect(speedStrokeWidth(100000)).toBe(3);
  });

  it("maps speed labels back to Mbps", () => {
    expect(speedLabelToMbps("10G")).toBe(10000);
    expect(speedLabelToMbps("100M")).toBe(100);
    expect(speedLabelToMbps(undefined)).toBe(0);
    expect(speedLabelToMbps("weird")).toBe(0);
    expect(speedStrokeWidth(speedLabelToMbps("40G"))).toBe(3);
  });
});

describe("zoomTier", () => {
  it("splits zoom into far / mid / close at the documented boundaries", () => {
    expect(ZOOM_TIER_FAR_BELOW).toBe(0.5);
    expect(ZOOM_TIER_CLOSE_ABOVE).toBe(1.1);
    expect(zoomTier(0.15)).toBe("far");
    expect(zoomTier(0.49)).toBe("far");
    expect(zoomTier(0.5)).toBe("mid");
    expect(zoomTier(1)).toBe("mid");
    expect(zoomTier(1.1)).toBe("mid");
    expect(zoomTier(1.11)).toBe("close");
    expect(zoomTier(6)).toBe("close");
    expect(zoomTier(Number.NaN)).toBe("far");
  });
});

describe("flow toggle default", () => {
  it("honors an explicit preference and defaults off for large maps", () => {
    expect(defaultFlowEnabled(null, 10)).toBe(true);
    expect(defaultFlowEnabled(null, FLOW_DEFAULT_EDGE_LIMIT)).toBe(true);
    expect(defaultFlowEnabled(null, FLOW_DEFAULT_EDGE_LIMIT + 1)).toBe(false);
    expect(defaultFlowEnabled(true, 5000)).toBe(true);
    expect(defaultFlowEnabled(false, 1)).toBe(false);
  });
});

describe("linkStatus", () => {
  const sw = (ip: string, ports: { name: string; oper_status: number }[], ping = "online") =>
    ({ id: 1, ip, ping_status: ping, ports: ports.map(p => ({ port_id: p.name, ...p })) }) as unknown as TopologyNode;
  const link = (overrides: Partial<TopologyLink> = {}): TopologyLink => ({
    id: 1,
    local_ip: "10.0.0.1",
    local_port: "1/1/1",
    remote_ip: "10.0.0.2",
    remote_port: "1/1/2",
    local_sys_name: "a",
    remote_sys_name: "b",
    speed_label: "1G",
    ...overrides,
  });

  it("uses the matched port oper_status first", () => {
    const up = new Map([["10.0.0.1", sw("10.0.0.1", [{ name: "1/1/1", oper_status: 1 }])]]);
    const down = new Map([["10.0.0.1", sw("10.0.0.1", [{ name: "1/1/1", oper_status: 2 }])]]);
    expect(linkStatus(link(), up)).toBe("up");
    expect(linkStatus(link(), down)).toBe("down");
  });

  it("falls back to reachability and speed knowledge", () => {
    const offline = new Map([["10.0.0.2", sw("10.0.0.2", [], "offline")]]);
    expect(linkStatus(link(), offline)).toBe("down");
    expect(linkStatus(link(), new Map())).toBe("up");
    expect(linkStatus(link({ speed_label: undefined }), new Map())).toBe("unknown");
  });

  it("aggregates member statuses", () => {
    expect(aggregateLinkStatus(["down", "up"])).toBe("up");
    expect(aggregateLinkStatus(["down", "down"])).toBe("down");
    expect(aggregateLinkStatus(["down", "unknown"])).toBe("unknown");
    expect(aggregateLinkStatus([])).toBe("unknown");
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{decodeURIComponent(location.pathname + location.search)}</div>;
}

describe("Show on map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryStorage();
    mockApiGet.mockImplementation(apiGetImpl);
    useNet2MapStore.setState({ focusDeviceId: null, selectedRack: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets focusDeviceId, selects the rack and navigates to /map", async () => {
    renderWithRouter(
      <>
        <InspectorDrawer />
        <LocationProbe />
      </>,
      { route: "/network?inspect=device:1" },
    );
    await screen.findByRole("dialog", { name: "core-sw1" });

    fireEvent.click(screen.getByRole("button", { name: /Show on map/ }));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/map?inspect=device:1"),
    );
    expect(useNet2MapStore.getState().focusDeviceId).toBe(1);
    expect(useNet2MapStore.getState().selectedRack?.id).toBe(7);
  });

  it("store focus can be cleared", () => {
    useNet2MapStore.getState().setFocusDevice(42);
    expect(useNet2MapStore.getState().focusDeviceId).toBe(42);
    useNet2MapStore.getState().clearFocusDevice();
    expect(useNet2MapStore.getState().focusDeviceId).toBeNull();
  });
});
