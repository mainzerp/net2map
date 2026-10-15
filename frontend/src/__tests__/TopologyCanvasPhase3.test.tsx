/**
 * Canvas-level tests for the topology map phase 3: semantic zoom attribute,
 * Flow toggle persistence, scan sweep overlay and "Show on map" focus
 * handling (the focus is consumed and cleared once the node exists), plus the
 * logical layer control (STP / VLAN), its persistence and legend.
 */
import React from "react";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import TopologyCanvas from "../features/topology/TopologyCanvas";
import useNet2MapStore from "../store";
import { FLOW_STORAGE_KEY } from "../features/topology/flowContext";
import {
  LAYER_STORAGE_KEY,
  LAYER_STP_INSTANCE_STORAGE_KEY,
  LAYER_VLAN_STORAGE_KEY,
} from "../features/topology/layerPreference";
import { vlanColor } from "../features/topology/vlanColor";
import { stubMemoryStorage } from "./test-utils";
import type { TopologyNode, RackInfo } from "../types";

// ── jsdom shims for @xyflow/react ────────────────────────────────────────────
beforeAll(() => {
  // xyflow hides nodes/edges until a ResizeObserver reports dimensions; the
  // mock fires one (zero-size) measurement per observed element so the flow
  // becomes visible and edges render under jsdom.
  class ResizeObserverMock {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      const entry = {
        target,
        contentRect: target.getBoundingClientRect(),
        borderBoxSize: [{ inlineSize: 0, blockSize: 0 }],
        contentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
        devicePixelContentBoxSize: [],
      } as unknown as ResizeObserverEntry;
      Promise.resolve().then(() =>
        this.callback([entry], this as unknown as ResizeObserver),
      );
    }
    unobserve() {}
    disconnect() {}
  }
  // @ts-expect-error test shim
  global.ResizeObserver = global.ResizeObserver || ResizeObserverMock;

  // xyflow reads the zoom scale out of DOMMatrixReadOnly transforms
  class DOMMatrixReadOnlyMock {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  // @ts-expect-error test shim
  global.DOMMatrixReadOnly = global.DOMMatrixReadOnly || DOMMatrixReadOnlyMock;

  // jsdom reports all-zero boxes; xyflow sizes nodes from offsetWidth/
  // offsetHeight and getBoundingClientRect, so honor inline width/height.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return parseFloat(this.style?.width || "0") || 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return parseFloat(this.style?.height || "0") || 0;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const width = parseFloat(el.style?.width || "0") || 0;
    const height = parseFloat(el.style?.height || "0") || 0;
    return {
      width,
      height,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

function makeNode(overrides: Partial<TopologyNode>): TopologyNode {
  return {
    id: 1,
    ip: "10.0.0.1",
    hostname: "",
    sys_name: "sw-1",
    vendor: "generic",
    model: "",
    mac: "",
    rack_id: null,
    class_id: null,
    model_id: null,
    x: null,
    y: null,
    map_x: 100,
    map_y: 100,
    ignored: false,
    role: "",
    ports_per_row: 24,
    total_ports: 24,
    ports: [],
    ...overrides,
  } as TopologyNode;
}

function makeRack(overrides: Partial<RackInfo>): RackInfo {
  return {
    id: 1,
    label: "Rack",
    location: "",
    room: "",
    row_pos: null,
    col_pos: null,
    ...overrides,
  };
}

const defaultProps = {
  links: [],
  managedRacks: [] as RackInfo[],
  switchClasses: [],
  filters: { racks: null, classes: null },
  onFilterChange: () => {},
  selectedRackId: undefined,
  selectedOutsideId: null,
  onSelectRack: () => {},
  onSelectOutside: () => {},
  onSearchSelect: () => {},
  onRackPositionChange: () => {},
  onDevicePositionChange: () => {},
  onAutoLayout: () => {},
  selectedLink: null,
  rackPairColorMap: {},
  mapBgUrl: null,
  mapBgOpacity: 0.3,
  mapBgScale: 1,
  mapBgColor: "var(--surface)",
  stats: { switches: 0, fast: 0, gig: 0 },
  updatedAt: null,
};

describe("TopologyCanvas phase 3", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = stubMemoryStorage();
    useNet2MapStore.setState({ focusDeviceId: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const nodes = [
    makeNode({ id: 7, ip: "10.0.1.1", sys_name: "sw-a", rack_id: 1, map_x: 300, map_y: 200 }),
    makeNode({ id: 9, ip: "10.0.9.9", sys_name: "sw-out", map_x: 700, map_y: 200 }),
  ];
  const managedRacks = [makeRack({ id: 1, label: "R1" })];

  it("exposes the zoom tier and flow state on the canvas wrapper", () => {
    const { container } = render(<TopologyCanvas {...defaultProps} nodes={nodes} managedRacks={managedRacks} />);
    const canvas = container.querySelector(".topo-canvas") as HTMLElement;
    expect(canvas).toBeTruthy();
    expect(["far", "mid", "close"]).toContain(canvas.dataset.zoomTier);
    expect(canvas.dataset.flow).toBe("on");
  });

  it("Flow toggle flips the overlay and persists the preference", () => {
    const { container } = render(<TopologyCanvas {...defaultProps} nodes={nodes} managedRacks={managedRacks} />);
    const toggle = screen.getByRole("button", { name: /Flow/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(storage.get(FLOW_STORAGE_KEY)).toBe("off");
    expect((container.querySelector(".topo-canvas") as HTMLElement).dataset.flow).toBe("off");
  });

  it("renders the scan overlay only while a scan is active", () => {
    const { rerender } = render(<TopologyCanvas {...defaultProps} nodes={nodes} managedRacks={managedRacks} />);
    expect(screen.queryByTestId("scan-overlay")).toBeNull();
    rerender(
      <TopologyCanvas
        {...defaultProps}
        nodes={nodes}
        managedRacks={managedRacks}
        scan={{ active: true, progress: 0.25, label: "Scanning 1 of 4 devices" }}
      />,
    );
    expect(screen.getByTestId("scan-overlay")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Scanning 1 of 4 devices");
  });

  it("consumes and clears a focus request for a racked device", async () => {
    useNet2MapStore.getState().setFocusDevice(7);
    render(<TopologyCanvas {...defaultProps} nodes={nodes} managedRacks={managedRacks} />);
    await waitFor(() => expect(useNet2MapStore.getState().focusDeviceId).toBeNull());
  });

  it("clears a focus request for a device that is not on the canvas", async () => {
    useNet2MapStore.getState().setFocusDevice(12345);
    render(<TopologyCanvas {...defaultProps} nodes={nodes} managedRacks={managedRacks} />);
    await waitFor(() => expect(useNet2MapStore.getState().focusDeviceId).toBeNull());
  });
});

describe("TopologyCanvas logical layers", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = stubMemoryStorage();
    useNet2MapStore.setState({ focusDeviceId: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stpInfo = { protocol: "rstp" as const, bridge_id: null, root_id: "8000.aa", root_cost: 0, root_port: null, is_root: false };
  const layeredNodes = [
    makeNode({
      id: 7,
      ip: "10.0.1.1",
      sys_name: "core",
      map_x: 200,
      map_y: 200,
      stp: { ...stpInfo, is_root: true },
      vlan_names: { "20": "Clients" },
      ports: [
        { port_id: "1", name: "1", oper_status: 1, speed: 1000, vlan: 10, tagged_vlans: [20], poe_status: null, endpoint_count: 0, stp_role: "designated" },
        { port_id: "2", name: "2", oper_status: 1, speed: 1000, vlan: 20, tagged_vlans: [], poe_status: null, endpoint_count: 0, stp_role: "designated" },
      ],
    }),
    makeNode({
      id: 9,
      ip: "10.0.9.9",
      sys_name: "access",
      map_x: 700,
      map_y: 200,
      stp: { ...stpInfo, root_cost: 4, root_port: "49" },
      ports: [
        { port_id: "49", name: "49", oper_status: 1, speed: 1000, vlan: 10, tagged_vlans: [20], poe_status: null, endpoint_count: 0, stp_role: "root" },
        { port_id: "50", name: "50", oper_status: 1, speed: 1000, vlan: 20, tagged_vlans: [], poe_status: null, endpoint_count: 0, stp_role: "blocked" },
      ],
    }),
  ];
  const layeredLinks = [
    { id: 1, local_ip: "10.0.9.9", local_port: "49", remote_ip: "10.0.1.1", remote_port: "1", local_sys_name: "access", remote_sys_name: "core", speed_label: "1G" },
    { id: 2, local_ip: "10.0.9.9", local_port: "50", remote_ip: "10.0.1.1", remote_port: "2", local_sys_name: "access", remote_sys_name: "core", speed_label: "1G" },
  ];
  const layerButton = (name: string) =>
    within(screen.getByRole("group", { name: "Map layer" })).getByRole("button", { name });

  it("Layer control switches layers, persists the choice and toggles the legend", async () => {
    const { container } = render(<TopologyCanvas {...defaultProps} nodes={layeredNodes} links={layeredLinks} />);
    const canvas = container.querySelector(".topo-canvas") as HTMLElement;
    expect(canvas.dataset.layer).toBe("off");
    expect(screen.queryByTestId("map-layer-legend")).toBeNull();

    fireEvent.click(layerButton("STP"));
    expect(layerButton("STP").getAttribute("aria-pressed")).toBe("true");
    expect(storage.get(LAYER_STORAGE_KEY)).toBe("stp");
    expect(canvas.dataset.layer).toBe("stp");
    expect(screen.getByTestId("map-layer-legend").textContent).toContain("Spanning tree");
    expect(screen.getByTestId("stp-root-badge")).toBeTruthy();
    expect(screen.getAllByTestId("stp-protocol-badge").map((b) => b.textContent)).toEqual(["RSTP", "RSTP"]);
    expect(screen.getByTestId("stp-protocols").textContent).toContain("RSTP 2");
    // The parallel root + blocked links render one edge with a blocked marker.
    expect((await screen.findByTestId("stp-blocked-marker")).textContent).toContain("1 blocked");

    fireEvent.click(layerButton("Off"));
    expect(storage.get(LAYER_STORAGE_KEY)).toBe("off");
    expect(screen.queryByTestId("map-layer-legend")).toBeNull();
    expect(screen.queryByTestId("stp-root-badge")).toBeNull();
    expect(screen.queryByTestId("stp-protocol-badge")).toBeNull();
  });

  it("marks protocol boundaries and switches the STP layer to an MSTI", async () => {
    const [core, access] = layeredNodes;
    const mstpNodes = [
      {
        ...core,
        stp: { ...stpInfo, protocol: "mstp" as const, is_root: true },
        stp_instances: [{ id: 3, bridge_id: null, root_id: null, root_cost: 0, root_port: null, vlans: "20", is_root: false }],
        ports: core.ports.map((p) => ({ ...p, stp_instances: { "3": { state: "forwarding" as const, role: "root" as const } } })),
      },
      access,
    ];
    storage.set(LAYER_STORAGE_KEY, "stp");
    render(<TopologyCanvas {...defaultProps} nodes={mstpNodes} links={layeredLinks} />);
    expect((await screen.findByTestId("stp-boundary-marker")).textContent).toBe("MSTP|RSTP");
    expect(screen.getByTestId("map-layer-legend").textContent).toContain("Protocol boundary (1)");

    const picker = screen.getByRole("combobox", { name: "STP instance" }) as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(["CIST (instance 0)", "MSTI 3 · VLAN 20"]);
    expect(picker.value).toBe("0");
    fireEvent.change(picker, { target: { value: "3" } });
    expect(storage.get(LAYER_STP_INSTANCE_STORAGE_KEY)).toBe("3");
    expect(screen.getByTestId("stp-instance-label").textContent).toBe("MSTI 3 · VLAN 20");
    // MSTI 3 has no blocked port, unlike the CIST.
    await waitFor(() => expect(screen.queryByTestId("stp-blocked-marker")).toBeNull());
    // The access switch does not take part in MSTI 3: no root badge anywhere.
    expect(screen.queryByTestId("stp-root-badge")).toBeNull();
  });

  it("restores a stored layer and VLAN on mount", () => {
    storage.set(LAYER_STORAGE_KEY, "vlan");
    storage.set(LAYER_VLAN_STORAGE_KEY, "10");
    render(<TopologyCanvas {...defaultProps} nodes={layeredNodes} links={layeredLinks} />);
    expect(layerButton("VLAN").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("combobox", { name: "VLAN" }) as HTMLSelectElement).value).toBe("10");
    expect(screen.getByTestId("map-layer-legend").textContent).toContain("VLAN 10");
  });

  it("VLAN picker lists all VLANs with names and persists the selection", () => {
    render(<TopologyCanvas {...defaultProps} nodes={layeredNodes} links={layeredLinks} />);
    expect(screen.queryByRole("combobox", { name: "VLAN" })).toBeNull();
    fireEvent.click(layerButton("VLAN"));
    const picker = screen.getByRole("combobox", { name: "VLAN" }) as HTMLSelectElement;
    expect(Array.from(picker.options).map(o => o.textContent)).toEqual(["10", "20 · Clients"]);
    // Default: most common VLAN other than 1.
    expect(picker.value).toBe("20");
    expect(screen.getAllByTestId("vlan-port-badge").map(b => b.textContent)).toEqual(["2", "2"]);
    fireEvent.change(picker, { target: { value: "10" } });
    expect(storage.get(LAYER_VLAN_STORAGE_KEY)).toBe("10");
    expect(screen.getByTestId("map-layer-legend").textContent).toContain("VLAN 10");
  });

  it("colors edges, badges, legend and picker with the selected VLAN's own color", async () => {
    const { container } = render(<TopologyCanvas {...defaultProps} nodes={layeredNodes} links={layeredLinks} />);
    fireEvent.click(layerButton("VLAN"));
    const c20 = vlanColor(20);
    const c10 = vlanColor(10);
    expect(c20.stroke).not.toBe(c10.stroke);

    const inkStroke = async () => {
      await waitFor(() => expect(container.querySelector('[data-overlay="emphasized"] .topo-edge-ink')).not.toBeNull());
      return (container.querySelector('[data-overlay="emphasized"] .topo-edge-ink') as SVGPathElement).style.stroke;
    };
    const legendStroke = () =>
      (screen.getByTestId("map-layer-legend").querySelector("line") as SVGLineElement).style.stroke;

    expect(await inkStroke()).toBe(c20.stroke);
    expect(legendStroke()).toBe(c20.stroke);
    expect(screen.getAllByTestId("vlan-port-badge")[0].style.color).toBe(c20.stroke);
    expect(screen.getByTestId("vlan-color-swatch").style.backgroundColor).toBe(c20.stroke);

    fireEvent.change(screen.getByRole("combobox", { name: "VLAN" }), { target: { value: "10" } });
    await waitFor(async () => expect(await inkStroke()).toBe(c10.stroke));
    expect(legendStroke()).toBe(c10.stroke);
    expect(screen.getByTestId("vlan-color-swatch").style.backgroundColor).toBe(c10.stroke);
  });

  it("disables STP and VLAN without data and ignores a stale stored layer", () => {
    storage.set(LAYER_STORAGE_KEY, "stp");
    const plainNodes = [makeNode({ id: 3, ip: "10.0.3.3", sys_name: "plain" })];
    const { container } = render(<TopologyCanvas {...defaultProps} nodes={plainNodes} />);
    const stp = layerButton("STP");
    expect(stp.getAttribute("aria-disabled")).toBe("true");
    expect(stp.getAttribute("title")).toMatch(/No spanning tree data/);
    expect(layerButton("VLAN").getAttribute("aria-disabled")).toBe("true");
    expect((container.querySelector(".topo-canvas") as HTMLElement).dataset.layer).toBe("off");
    expect(screen.queryByTestId("map-layer-legend")).toBeNull();
    fireEvent.click(stp);
    expect(layerButton("Off").getAttribute("aria-pressed")).toBe("true");
  });
});
