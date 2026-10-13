/**
 * Tests for UPS / server health: the inspector "health" section for both
 * kinds, the rack faceplate health strip, the U height stepper cap, the
 * dashboard attention rows and the pure helpers in utils/deviceHealth.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

const mockApiGet = vi.fn();
const mockApiPatch = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    del: vi.fn(),
    invalidate: vi.fn(),
  },
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  getStoredUser: () => ({ username: "admin", role: "admin" }),
  getStoredToken: () => "token",
  normPort: (s: string) => (s || "").trim().toLowerCase(),
  API: "",
}));

// Must import after mocks are set up
import { DeviceHealthSection } from "../features/inspector/DeviceHealthSection";
import RackElevation, { HealthStrip, MAX_DEVICE_U } from "../features/racks/RackElevation";
import { AttentionCard } from "../features/dashboard/AttentionCard";
import DeviceNode from "../features/topology/nodes/DeviceNode";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { DeviceFlowNode } from "../features/topology/flowTypes";
import { formatRuntime, healthSummary, isPowerOrServer, needsAttention } from "../utils/deviceHealth";
import type { RackInfo, ServerHealth, TopologyNode, UpsHealth } from "../types";

function makeNode(partial: Partial<TopologyNode>): TopologyNode {
  return {
    id: 0,
    ip: "10.0.0.1",
    hostname: "dev",
    sys_name: "dev",
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

const UPS: UpsHealth = {
  kind: "ups",
  status: "warning",
  manufacturer: "EATON",
  model: "Eaton 9PX 3000",
  software: "01.14",
  battery_status: "normal",
  seconds_on_battery: 300,
  runtime_minutes: 75,
  charge_percent: 64,
  battery_temperature_c: 25,
  output_source: "battery",
  load_percent: 31,
  input_voltage: 0,
  alarms_present: 1,
};

const SERVER: ServerHealth = {
  kind: "server",
  status: "critical",
  overall: "failed",
  thermal: "ok",
  power_supply: "degraded",
  fans: "ok",
  storage: "failed",
  temperature_max_c: 48,
  temperature_sensors: 12,
  product_name: "ProLiant DL380 Gen10",
  serial_number: "CZ1234ABCD",
  ilo_firmware: "2.72",
};

const RECENT = new Date(Date.now() - 5 * 60 * 1000).toISOString();

describe("DeviceHealthSection", () => {
  it("renders UPS charge, runtime, load, source and battery status", () => {
    render(
      <DeviceHealthSection
        device={makeNode({ id: 3, device_type: "ups", health: UPS, health_updated_at: RECENT })}
      />,
    );
    expect(screen.getByRole("heading", { name: "UPS health" })).toBeTruthy();
    expect(screen.getByTestId("health-status").textContent).toBe("Warning");
    expect(screen.getByRole("img", { name: "Battery charge 64%" })).toBeTruthy();
    expect(screen.getByText("1 h 15 min")).toBeTruthy();
    expect(screen.getByText("31%")).toBeTruthy();
    // "Battery" is both the battery status label and the output source value
    expect(screen.getAllByText("Battery").length).toBe(2);
    expect(screen.getByText("Normal")).toBeTruthy(); // battery status
    expect(screen.getByText("5 min")).toBeTruthy(); // on battery
    expect(screen.getByText("Updated 5m ago")).toBeTruthy();
  });

  it("renders server subsystem conditions and the max temperature", () => {
    render(<DeviceHealthSection device={makeNode({ id: 4, device_type: "server", health: SERVER })} />);
    const section = screen.getByRole("heading", { name: "Server health" }).closest("section") as HTMLElement;
    expect(screen.getByTestId("health-status").textContent).toBe("Critical");
    expect(within(section).getAllByText("Failed").length).toBe(2);
    expect(within(section).getByText("Degraded")).toBeTruthy();
    expect(within(section).getByText("48 C max (12 sensors)")).toBeTruthy();
    expect(within(section).getByText("2.72")).toBeTruthy();
    expect(within(section).queryByText(/^Updated/)).toBeNull();
  });

  it("renders nothing without a health snapshot", () => {
    const { container } = render(<DeviceHealthSection device={makeNode({ device_type: "ups", health: null })} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("HealthStrip", () => {
  it("shows a charge bar for a UPS", () => {
    render(<HealthStrip device={makeNode({ device_type: "ups", health: UPS })} />);
    const strip = screen.getByTestId("health-strip");
    expect(strip.getAttribute("data-kind")).toBe("ups");
    expect(strip.getAttribute("data-status")).toBe("warning");
    const bar = screen.getByTestId("health-charge-bar");
    expect(bar.style.width).toBe("64%");
    expect(bar.className).toContain("bg-warning");
    expect(strip.textContent).toContain("64%");
  });

  it("shows a condition dot for a server", () => {
    render(<HealthStrip device={makeNode({ device_type: "server", health: SERVER })} />);
    const strip = screen.getByTestId("health-strip");
    expect(strip.getAttribute("data-kind")).toBe("server");
    expect(screen.getByTestId("health-condition-dot").className).toContain("bg-danger");
    expect(strip.textContent).toContain("Critical");
  });

  it("shows a hint without health data", () => {
    render(<HealthStrip device={makeNode({ device_type: "server", health: null })} />);
    expect(screen.getByTestId("health-strip").textContent).toBe("No health data");
  });
});

describe("RackElevation faceplates for UPS / server", () => {
  const RACK: RackInfo = { id: 1, label: "Rack A", location: "", room: "", height_u: 12, row_pos: null, col_pos: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue([]);
    mockApiPatch.mockResolvedValue({});
  });

  it("replaces the empty port block with the health strip", async () => {
    const nodes = [
      makeNode({ id: 1, sys_name: "ups-1", device_type: "ups", health: UPS, rack_id: 1, rack_u_position: 1, u_height: 2 }),
      makeNode({ id: 2, sys_name: "sw-1", rack_id: 1, rack_u_position: 5 }),
    ];
    renderWithRouter(<RackElevation rack={RACK} nodes={nodes} />);
    const ups = await screen.findByTestId("faceplate-1");
    expect(within(ups).getByTestId("health-strip").getAttribute("data-kind")).toBe("ups");
    expect(within(ups).queryByTestId("port-block")).toBeNull();
    expect(within(screen.getByTestId("faceplate-2")).queryByTestId("health-strip")).toBeNull();
  });

  it("allows raising the U height up to the new cap", async () => {
    expect(MAX_DEVICE_U).toBe(10);
    const nodes = [makeNode({ id: 1, sys_name: "srv", device_type: "server", rack_id: 1, rack_u_position: 1, u_height: 4 })];
    renderWithRouter(<RackElevation rack={RACK} nodes={nodes} />);
    const inc = await screen.findByRole("button", { name: "Increase U height of srv" });
    expect((inc as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(inc);
    await waitFor(() =>
      expect(mockApiPatch).toHaveBeenCalledWith("/api/topology/devices/1/meta", expect.objectContaining({ u_height: 5 })),
    );
  });
});

function renderNode(device: TopologyNode) {
  const props = { id: String(device.id), data: { device, classColor: null, inRack: false }, selected: false };
  return render(
    <ReactFlowProvider>
      <DeviceNode {...(props as unknown as NodeProps<DeviceFlowNode>)} />
    </ReactFlowProvider>,
  );
}

describe("DeviceNode device types", () => {
  const port = { port_id: "1", name: "1", oper_status: 1, speed: 1000, vlan: 1, tagged_vlans: [], poe_status: null, endpoint_count: 0 };

  it("shows the active/total port counter for switches", () => {
    const { container } = renderNode(makeNode({ id: 1, sys_name: "sw", ports: [port] }));
    expect(container.textContent).toContain("1/1");
    expect(screen.queryByTestId("node-type-icon")).toBeNull();
  });

  it("shows a type icon and the health dot instead of 0/0 for a UPS", () => {
    const { container } = renderNode(makeNode({ id: 2, sys_name: "ups", device_type: "ups", health: UPS }));
    expect(screen.getByTestId("node-type-icon").getAttribute("aria-label")).toBe("UPS");
    expect(container.textContent).not.toContain("0/0");
    expect(screen.getByTestId("node-health").textContent).toBe("64%");
  });

  it("shows a server icon without health data", () => {
    const { container } = renderNode(makeNode({ id: 3, sys_name: "srv", device_type: "server" }));
    expect(screen.getByTestId("node-type-icon").getAttribute("aria-label")).toBe("Server");
    expect(container.textContent).not.toContain("0/0");
    expect(screen.queryByTestId("node-health")).toBeNull();
  });
});

describe("AttentionCard health rows", () => {
  it("lists UPS / server devices with warning or critical health", () => {
    const nodes = [
      makeNode({ id: 1, sys_name: "ups-1", rack_id: 1, ping_status: "online", device_type: "ups", health: UPS }),
      makeNode({ id: 2, sys_name: "srv-1", rack_id: 1, ping_status: "online", device_type: "server", health: SERVER }),
      makeNode({
        id: 3, sys_name: "ups-ok", rack_id: 1, ping_status: "online", device_type: "ups",
        health: { ...UPS, status: "ok" },
      }),
    ];
    renderWithRouter(<AttentionCard nodes={nodes} />);
    expect(screen.getByText("2 open items")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open details for srv-1 (health critical)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open details for ups-1 (health warning)" })).toBeTruthy();
    expect(screen.queryByText("ups-ok")).toBeNull();
  });
});

describe("deviceHealth helpers", () => {
  it("summarizes reasons", () => {
    expect(healthSummary(UPS)).toBe("UPS on battery, 1 alarm, 64% charge");
    expect(healthSummary(SERVER)).toBe("Server: overall failed, power degraded, storage failed");
  });

  it("classifies devices", () => {
    expect(isPowerOrServer(makeNode({ device_type: "ups" }))).toBe(true);
    expect(isPowerOrServer(makeNode({ device_type: "firewall" }))).toBe(false);
    expect(isPowerOrServer(makeNode({}))).toBe(false);
    expect(needsAttention(makeNode({ health: UPS }))).toBe(true);
    expect(needsAttention(makeNode({ health: { ...UPS, status: "ok" } }))).toBe(false);
  });

  it("formats runtime", () => {
    expect(formatRuntime(42)).toBe("42 min");
    expect(formatRuntime(120)).toBe("2 h");
    expect(formatRuntime(null)).toBeNull();
  });
});
