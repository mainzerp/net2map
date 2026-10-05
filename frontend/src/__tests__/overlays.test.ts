/**
 * Unit tests for the pure logical-layer classification (overlays.ts).
 */
import { describe, it, expect } from "vitest";
import {
  collectVlanOptions,
  defaultVlan,
  hasStpData,
  classifyLinkVlan,
  classifyAggregatedVlan,
  deviceVlanPortCount,
  classifyLinkStp,
  classifyAggregatedStp,
  stpDomainCount,
  nodeOverlay,
} from "../features/topology/overlays";
import { vlanColor } from "../features/topology/vlanColor";
import type { DeviceStpInfo, PortInfo, TopologyLink, TopologyNode } from "../types";

function port(name: string, extra: Partial<PortInfo> = {}): PortInfo {
  return {
    port_id: name,
    name,
    oper_status: 1,
    speed: 1000,
    vlan: null,
    tagged_vlans: [],
    poe_status: null,
    endpoint_count: 0,
    ...extra,
  };
}

function device(id: number, ip: string, ports: PortInfo[], extra: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id,
    ip,
    hostname: "",
    sys_name: `sw-${id}`,
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
    total_ports: ports.length,
    ports,
    ...extra,
  } as TopologyNode;
}

function link(id: number, localIp: string, localPort: string, remoteIp: string, remotePort: string): TopologyLink {
  return {
    id,
    local_ip: localIp,
    local_port: localPort,
    remote_ip: remoteIp,
    remote_port: remotePort,
    local_sys_name: "",
    remote_sys_name: "",
    speed_label: "1G",
  };
}

function stp(extra: Partial<DeviceStpInfo> = {}): DeviceStpInfo {
  return { protocol: "rstp", bridge_id: null, root_id: "8000.aa", root_cost: 4, root_port: "1", is_root: false, ...extra };
}

const byIp = (nodes: TopologyNode[]) => new Map(nodes.map(n => [n.ip, n]));

describe("collectVlanOptions", () => {
  it("collects untagged and tagged VLANs, sorted numerically, with names", () => {
    const nodes = [
      device(1, "10.0.0.1", [port("1", { vlan: 20 }), port("2", { vlan: 1, tagged_vlans: [100, 20, 3] })], {
        vlan_names: { "20": "Clients", "3": "" },
      }),
      device(2, "10.0.0.2", [port("1", { vlan: 20 })], { vlan_names: { "20": "Other name", "3": "Mgmt" } }),
    ];
    const options = collectVlanOptions(nodes);
    expect(options.map(o => o.id)).toEqual([1, 3, 20, 100]);
    expect(options.find(o => o.id === 20)?.label).toBe("20 · Clients");
    expect(options.find(o => o.id === 3)?.label).toBe("3 · Mgmt");
    expect(options.find(o => o.id === 100)?.label).toBe("100");
    expect(options.find(o => o.id === 20)?.portCount).toBe(3);
  });

  it("defaults to the most common VLAN other than 1, else 1", () => {
    const nodes = [
      device(1, "10.0.0.1", [port("1", { vlan: 1 }), port("2", { vlan: 1 }), port("3", { vlan: 30 }), port("4", { vlan: 40 }), port("5", { vlan: 40 })]),
    ];
    expect(defaultVlan(collectVlanOptions(nodes))).toBe(40);
    expect(defaultVlan(collectVlanOptions([device(1, "10.0.0.1", [port("1", { vlan: 1 })])]))).toBe(1);
    expect(defaultVlan([])).toBeNull();
  });

  it("returns no options when ports carry no VLAN data", () => {
    expect(collectVlanOptions([device(1, "10.0.0.1", [port("1")])])).toEqual([]);
  });
});

describe("VLAN classification", () => {
  const a = device(1, "10.0.0.1", [
    port("1/1/1", { tagged_vlans: [20, 30] }),
    port("1/1/2", { vlan: 20 }),
    port("1/1/3", { vlan: 99 }),
  ]);
  const b = device(2, "10.0.0.2", [port("49", { tagged_vlans: [20] }), port("50", { vlan: 20 }), port("51", { vlan: 99 })]);
  const nodes = byIp([a, b]);

  it("classifies tagged, untagged and non-carrying links", () => {
    expect(classifyLinkVlan(link(1, a.ip, "1/1/1", b.ip, "49"), nodes, 20)).toBe("tagged");
    expect(classifyLinkVlan(link(2, a.ip, "1/1/2", b.ip, "50"), nodes, 20)).toBe("untagged");
    expect(classifyLinkVlan(link(3, a.ip, "1/1/3", b.ip, "51"), nodes, 20)).toBe("none");
  });

  it("uses the one resolvable end when the other is unknown", () => {
    expect(classifyLinkVlan(link(4, a.ip, "1/1/1", "10.9.9.9", "x"), nodes, 30)).toBe("tagged");
    expect(classifyLinkVlan(link(5, "10.9.9.9", "x", b.ip, "50"), nodes, 20)).toBe("untagged");
  });

  it("treats links without resolvable ports as neutral", () => {
    expect(classifyLinkVlan(link(6, a.ip, "nope", b.ip, "nope"), nodes, 20)).toBe("none");
  });

  it("aggregated edges carry the VLAN if any member does; tagged wins", () => {
    const untaggedOnly = { individual: [link(2, a.ip, "1/1/2", b.ip, "50"), link(3, a.ip, "1/1/3", b.ip, "51")] };
    expect(classifyAggregatedVlan(untaggedOnly, nodes, 20)).toBe("untagged");
    const mixed = { individual: [link(2, a.ip, "1/1/2", b.ip, "50"), link(1, a.ip, "1/1/1", b.ip, "49")] };
    expect(classifyAggregatedVlan(mixed, nodes, 20)).toBe("tagged");
    expect(classifyAggregatedVlan({ individual: [link(3, a.ip, "1/1/3", b.ip, "51")] }, nodes, 20)).toBe("none");
  });

  it("counts member ports per device and fades nodes without members", () => {
    expect(deviceVlanPortCount(a, 20)).toBe(2);
    expect(nodeOverlay([a, b], "vlan", 20)).toEqual({ dim: "none", vlanPorts: 4, isRoot: false, color: vlanColor(20) });
    expect(nodeOverlay([a], "vlan", 777)).toEqual({ dim: "faded", vlanPorts: 0, isRoot: false, color: vlanColor(777) });
  });
});

describe("STP classification", () => {
  const root = device(1, "10.0.0.1", [port("1", { stp_role: "designated", stp_state: "forwarding" }), port("2", { stp_role: "designated" })], {
    stp: stp({ is_root: true, root_cost: 0, root_port: null }),
  });
  const access = device(2, "10.0.0.2", [
    port("49", { stp_role: "root", stp_state: "forwarding" }),
    port("50", { stp_role: "blocked", stp_state: "blocking" }),
    port("51", { stp_state: "broken" }),
  ], { stp: stp() });
  const nodes = byIp([root, access]);
  const endpoints = { [root.ip]: "1", [access.ip]: `outside:${access.id}` };

  it("detects root path links and the direction toward the root", () => {
    const c = classifyLinkStp(link(1, access.ip, "49", root.ip, "1"), nodes);
    expect(c.state).toBe("root");
    expect(c.towardRootIp).toBe(root.ip);
    const reversed = classifyLinkStp(link(2, root.ip, "1", access.ip, "49"), nodes);
    expect(reversed.towardRootIp).toBe(root.ip);
  });

  it("detects blocked links by role or blocking/broken state", () => {
    expect(classifyLinkStp(link(3, root.ip, "2", access.ip, "50"), nodes)).toMatchObject({ state: "blocked", blockedIp: access.ip });
    expect(classifyLinkStp(link(4, access.ip, "51", root.ip, "2"), nodes).state).toBe("blocked");
  });

  it("returns forwarding for designated-only links and unknown without STP data", () => {
    expect(classifyLinkStp(link(5, root.ip, "1", "10.9.9.9", "x"), nodes).state).toBe("forwarding");
    const plain = byIp([device(5, "10.0.0.5", [port("1")]), device(6, "10.0.0.6", [port("1")])]);
    expect(classifyLinkStp(link(6, "10.0.0.5", "1", "10.0.0.6", "1"), plain).state).toBe("unknown");
  });

  it("aggregates parallel root and blocked members", () => {
    const agg = { individual: [link(1, access.ip, "49", root.ip, "1"), link(3, root.ip, "2", access.ip, "50")] };
    expect(classifyAggregatedStp(agg, nodes, endpoints)).toEqual({
      state: "root",
      rootCount: 1,
      blockedCount: 1,
      towardRoot: "1",
      blockedEnd: `outside:${access.id}`,
    });
    const blockedOnly = { individual: [link(3, root.ip, "2", access.ip, "50")] };
    expect(classifyAggregatedStp(blockedOnly, nodes, endpoints).state).toBe("blocked");
  });

  it("counts distinct root domains and flags STP availability", () => {
    expect(stpDomainCount([root, access])).toBe(1);
    const other = device(3, "10.0.0.3", [], { stp: stp({ root_id: "8000.BB" }) });
    expect(stpDomainCount([root, access, other])).toBe(2);
    expect(stpDomainCount([device(4, "10.0.0.4", [])])).toBe(0);
    expect(hasStpData([device(4, "10.0.0.4", [])])).toBe(false);
    expect(hasStpData([root])).toBe(true);
  });

  it("marks root nodes and strongly fades devices without STP data", () => {
    expect(nodeOverlay([access, root], "stp", null)).toEqual({ dim: "none", vlanPorts: null, isRoot: true });
    expect(nodeOverlay([access], "stp", null).isRoot).toBe(false);
    expect(nodeOverlay([device(4, "10.0.0.4", [])], "stp", null).dim).toBe("strong");
    expect(nodeOverlay([root], "off", null).dim).toBe("none");
  });
});
