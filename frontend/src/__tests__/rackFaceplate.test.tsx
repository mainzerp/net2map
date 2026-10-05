/**
 * Tests for the phase 4 rack faceplates: the pure port socket layout helper
 * (two-row split, uplink heuristic, compact threshold, tooltip text) and the
 * RacksPage "Activity" toggle (persistence, reduced-motion behaviour).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithRouter, stubMemoryStorage } from "./test-utils";

const mockApiGet = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    invalidate: vi.fn(),
  },
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  getStoredUser: () => ({ username: "admin", role: "admin" }),
  getStoredToken: () => "token",
  normPort: (s: string) => (s || "").trim().toLowerCase(),
  API: "",
}));

import RacksPage from "../pages/RacksPage";
import {
  COMPACT_PORT_THRESHOLD,
  TWO_ROW_THRESHOLD,
  activityTiming,
  isUplinkPort,
  layoutPortSockets,
  portTitle,
  splitRows,
} from "../features/racks/portSockets";
import { RACK_ACTIVITY_STORAGE_KEY } from "../features/racks/useRackActivity";
import type { PortInfo, TopologyData, TopologyNode } from "../types";

function makePort(partial: Partial<PortInfo>): PortInfo {
  return {
    port_id: String(partial.if_index ?? 0),
    name: `${partial.if_index ?? 0}`,
    oper_status: 2,
    speed: 0,
    vlan: null,
    tagged_vlans: [],
    poe_status: null,
    endpoint_count: 0,
    ...partial,
  };
}

function accessPorts(n: number, start = 1): PortInfo[] {
  return Array.from({ length: n }, (_, i) =>
    makePort({ id: start + i, if_index: start + i, name: `${start + i}`, speed_mbps: 1000 }),
  );
}

describe("isUplinkPort heuristic", () => {
  it("treats ports at 10G or faster as uplinks", () => {
    expect(isUplinkPort(makePort({ name: "49", speed_mbps: 10000 }))).toBe(true);
    expect(isUplinkPort(makePort({ name: "50", speed: 25000 }))).toBe(true);
    expect(isUplinkPort(makePort({ name: "1", speed_mbps: 1000 }))).toBe(false);
  });

  it("detects uplinks by documented name hints", () => {
    expect(isUplinkPort(makePort({ name: "sfp1" }))).toBe(true);
    expect(isUplinkPort(makePort({ name: "1/1/SFP2" }))).toBe(true);
    expect(isUplinkPort(makePort({ name: "Uplink 1" }))).toBe(true);
    expect(isUplinkPort(makePort({ name: "25GigE1/0/1" }))).toBe(true);
    expect(isUplinkPort(makePort({ name: "xg1" }))).toBe(true);
    expect(isUplinkPort(makePort({ name: "x", if_descr: "TenGigabitEthernet1/1" }))).toBe(true);
    expect(isUplinkPort(makePort({ name: "Te1/0/1" }))).toBe(true);
  });

  it("does not match 'te' or 'xg' inside ordinary names", () => {
    expect(isUplinkPort(makePort({ name: "GigabitEthernet1/0/1" }))).toBe(false);
    expect(isUplinkPort(makePort({ name: "ethernet5" }))).toBe(false);
    expect(isUplinkPort(makePort({ name: "port-7", if_descr: "Interface 7" }))).toBe(false);
  });
});

describe("layoutPortSockets", () => {
  it("keeps up to TWO_ROW_THRESHOLD ports in a single row", () => {
    expect(TWO_ROW_THRESHOLD).toBe(12);
    const layout = layoutPortSockets(accessPorts(12));
    expect(layout.twoRow).toBe(false);
    expect(layout.compact).toBe(false);
    expect(layout.access.top).toHaveLength(12);
    expect(layout.access.bottom).toHaveLength(0);
  });

  it("splits into odd (top) and even (bottom) positions above the threshold", () => {
    const layout = layoutPortSockets(accessPorts(24));
    expect(layout.twoRow).toBe(true);
    expect(layout.access.top.map((p) => p.if_index)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
    expect(layout.access.bottom.map((p) => p.if_index)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
  });

  it("groups uplinks separately at the end and sorts by if_index", () => {
    const ports = [
      makePort({ id: 50, if_index: 50, name: "sfp2" }),
      ...accessPorts(24).reverse(),
      makePort({ id: 49, if_index: 49, name: "sfp1" }),
    ];
    const layout = layoutPortSockets(ports);
    expect(layout.access.top).toHaveLength(12);
    expect(layout.uplinks.top.map((p) => p.if_index)).toEqual([49]);
    expect(layout.uplinks.bottom.map((p) => p.if_index)).toEqual([50]);
    expect(layout.ports[0].if_index).toBe(1);
  });

  it("draws an all-uplink device as a regular block", () => {
    const ports = Array.from({ length: 4 }, (_, i) =>
      makePort({ id: i + 1, if_index: i + 1, speed_mbps: 10000 }),
    );
    const layout = layoutPortSockets(ports);
    expect(layout.access.top).toHaveLength(4);
    expect(layout.uplinks.top).toHaveLength(0);
  });

  it("cuts the list at total_ports", () => {
    const layout = layoutPortSockets(accessPorts(30), 24);
    expect(layout.ports).toHaveLength(24);
  });

  it("switches to compact mode above COMPACT_PORT_THRESHOLD ports", () => {
    expect(COMPACT_PORT_THRESHOLD).toBe(96);
    expect(layoutPortSockets(accessPorts(96)).compact).toBe(false);
    expect(layoutPortSockets(accessPorts(97)).compact).toBe(true);
  });

  it("splitRows alternates positions", () => {
    const ports = accessPorts(5);
    expect(splitRows(ports, false)).toEqual({ top: ports, bottom: [] });
    const two = splitRows(ports, true);
    expect(two.top.map((p) => p.if_index)).toEqual([1, 3, 5]);
    expect(two.bottom.map((p) => p.if_index)).toEqual([2, 4]);
  });
});

describe("portTitle and activityTiming", () => {
  it("summarises name, status, speed, VLAN and endpoints", () => {
    const up = makePort({ if_descr: "1/1/1", oper_status: 1, speed_mbps: 1000, vlan: 10, endpoint_count: 3 });
    expect(portTitle(up)).toBe("1/1/1 - up - 1G - VLAN 10 - 3 endpoints");
    const down = makePort({ name: "7", oper_status: 2, endpoint_count: 1 });
    expect(portTitle(down)).toBe("7 - down - speed unknown - no VLAN - 1 endpoint");
  });

  it("returns deterministic timings within the documented ranges", () => {
    for (let i = 0; i < 50; i++) {
      const t = activityTiming(7, i);
      expect(t).toEqual(activityTiming(7, i));
      expect(t.delay).toBeGreaterThanOrEqual(0);
      expect(t.delay).toBeLessThan(4);
      expect(t.duration).toBeGreaterThanOrEqual(3);
      expect(t.duration).toBeLessThan(5);
    }
  });
});

// ── Activity toggle ──────────────────────────────────────────────────────────

function makeNode(partial: Partial<TopologyNode>): TopologyNode {
  return {
    id: 0,
    ip: "10.0.0.1",
    hostname: "sw",
    sys_name: "sw",
    vendor: "generic",
    model: "",
    mac: "",
    rack_id: null,
    class_id: null,
    model_id: null,
    x: null,
    y: null,
    map_x: 0,
    map_y: 0,
    ignored: false,
    role: "",
    ports_per_row: 24,
    total_ports: 0,
    ports: [],
    ...partial,
  };
}

const TOPOLOGY: TopologyData = {
  nodes: [
    makeNode({
      id: 1,
      sys_name: "sw-core",
      rack_id: 1,
      rack_u_position: 1,
      ports: [
        makePort({ id: 1, if_index: 1, oper_status: 1, speed_mbps: 1000 }),
        makePort({ id: 2, if_index: 2, oper_status: 2 }),
      ],
    }),
  ],
  links: [],
  racks: [{ id: 1, label: "Rack A", location: "", room: "", height_u: 12, row_pos: null, col_pos: null }],
  classes: [],
  models: [],
};

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("RacksPage activity toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryStorage();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/topology") return Promise.resolve(structuredClone(TOPOLOGY));
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is off by default and blinks no port tiles", async () => {
    stubReducedMotion(false);
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    const toggle = await screen.findByTestId("rack-activity-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await screen.findByTestId("faceplate-1");
    expect(document.querySelectorAll(".rack-tile-blink")).toHaveLength(0);
  });

  it("persists the preference and blinks only up port tiles when enabled", async () => {
    stubReducedMotion(false);
    const { unmount } = renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    const toggle = await screen.findByTestId("rack-activity-toggle");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(RACK_ACTIVITY_STORAGE_KEY)).toBe("1");

    const blinking = document.querySelectorAll<HTMLElement>(".rack-tile-blink");
    expect(blinking).toHaveLength(1);
    expect(blinking[0].getAttribute("data-status")).toBe("up");
    expect(blinking[0].style.animationDuration).toMatch(/s$/);
    unmount();

    // A fresh mount restores the stored preference.
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    const again = await screen.findByTestId("rack-activity-toggle");
    expect(again.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(again);
    expect(window.localStorage.getItem(RACK_ACTIVITY_STORAGE_KEY)).toBe("0");
    expect(document.querySelectorAll(".rack-tile-blink")).toHaveLength(0);
  });

  it("is absent and inactive under prefers-reduced-motion", async () => {
    stubReducedMotion(true);
    window.localStorage.setItem(RACK_ACTIVITY_STORAGE_KEY, "1");
    renderWithRouter(<RacksPage />, { route: "/racks?rack=1" });
    await screen.findByTestId("faceplate-1");
    expect(screen.queryByTestId("rack-activity-toggle")).toBeNull();
    expect(document.querySelectorAll(".rack-tile-blink")).toHaveLength(0);
  });
});
