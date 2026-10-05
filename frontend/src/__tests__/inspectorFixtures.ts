/**
 * Shared topology / endpoint fixtures for the inspector and palette tests.
 */
import type { Endpoint, PortInfo, TopologyData, TopologyNode } from "../types";

function port(id: number, name: string, up: boolean): PortInfo {
  return {
    id,
    port_id: String(id),
    name,
    if_index: id,
    oper_status: up ? 1 : 2,
    speed: 1000,
    speed_mbps: 1000,
    vlan: 10,
    tagged_vlans: [],
    poe_status: null,
    endpoint_count: 0,
  };
}

function node(id: number, sysName: string, ip: string, extra: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id,
    ip,
    hostname: sysName,
    sys_name: sysName,
    vendor: "Aruba",
    model: "6300M",
    mac: `00:1a:2b:3c:4d:${String(id).padStart(2, "0")}`,
    rack_id: 7,
    class_id: null,
    model_id: null,
    x: null,
    y: null,
    map_x: 0,
    map_y: 0,
    ignored: false,
    role: "switch",
    ports_per_row: 24,
    total_ports: 2,
    ports: [port(id * 100 + 1, "1/1/1", true), port(id * 100 + 2, "1/1/2", false)],
    ping_status: "online",
    ...extra,
  };
}

export const TOPOLOGY: TopologyData = {
  nodes: [
    node(1, "core-sw1", "10.0.1.5", { rack_u_position: 40 }),
    node(2, "core-sw2", "10.0.1.6", { rack_u_position: 38 }),
    node(3, "access-sw1", "10.0.2.10", { rack_id: null, ping_status: "offline" }),
  ],
  links: [
    {
      id: 1,
      local_ip: "10.0.1.5",
      local_port: "1/1/1",
      remote_ip: "10.0.1.6",
      remote_port: "1/1/1",
      local_sys_name: "core-sw1",
      remote_sys_name: "core-sw2",
      speed_label: "10G",
    },
  ],
  racks: [{ id: 7, label: "Rack A1", location: "Building 1", room: "Server room", row_pos: null, col_pos: null, height_u: 42 }],
  classes: [],
  models: [],
};

export const ENDPOINTS: Endpoint[] = [
  {
    id: 10,
    mac: "aa:bb:cc:dd:ee:01",
    ip: "10.0.5.20",
    hostname: "printer-lobby",
    first_seen: null,
    last_seen: null,
    ignored: false,
    notes: "Front desk printer",
    found_on: [
      { port_id: 101, switch_ip: "10.0.1.5", switch_name: "core-sw1", port_name: "1/1/1", vlan_id: 10, last_seen: null },
    ],
  },
];

export function apiGetImpl(path: string): Promise<unknown> {
  if (path === "/api/topology") return Promise.resolve(TOPOLOGY);
  if (path === "/api/endpoints") return Promise.resolve(ENDPOINTS);
  if (path === "/api/devices") return Promise.resolve(TOPOLOGY.nodes);
  return Promise.resolve([]);
}
