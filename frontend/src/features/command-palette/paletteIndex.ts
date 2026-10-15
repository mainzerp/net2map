// Builds the searchable palette index from cached topology and endpoint data.

import type { InspectorKind, InspectorTarget } from "../../hooks/useInspector";
import type { Endpoint, TopologyData } from "../../types";
import { deviceDisplayName } from "../../utils/deviceSearch";
import type { PaletteIndex, SearchItem } from "./search";

export type PaletteCommand =
  | { type: "navigate"; to: string }
  | { type: "action"; action: "scan" | "theme" }
  | { type: "inspect"; kind: InspectorKind; id: number };

export type PaletteItem = SearchItem<PaletteCommand>;

export type PaletteIcon =
  | "dashboard"
  | "map"
  | "devices"
  | "network"
  | "racks"
  | "logs"
  | "settings"
  | "styleguide"
  | "scan"
  | "theme"
  | "switch"
  | "endpoint"
  | "rack"
  | "port";

interface PageDef {
  to: string;
  label: string;
  icon: PaletteIcon;
  keywords: string;
  hidden?: boolean;
}

const PAGES: PageDef[] = [
  { to: "/", label: "Dashboard", icon: "dashboard", keywords: "home overview" },
  { to: "/map", label: "Topology map", icon: "map", keywords: "map topology graph" },
  { to: "/endpoints", label: "Endpoints", icon: "devices", keywords: "devices clients hosts" },
  { to: "/network", label: "Network", icon: "network", keywords: "devices switches infrastructure" },
  { to: "/racks", label: "Racks", icon: "racks", keywords: "rack elevation" },
  { to: "/logs", label: "Logs", icon: "logs", keywords: "audit events history" },
  { to: "/settings", label: "Settings", icon: "settings", keywords: "credentials snmp configuration" },
  { to: "/styleguide", label: "Styleguide", icon: "styleguide", keywords: "styleguide design system", hidden: true },
];

function pageItems(): PaletteItem[] {
  return PAGES.map((page) => {
    return {
      key: `page:${page.to}`,
      group: "pages",
      label: page.label,
      detail: page.to,
      hint: "Page",
      fields: [{ text: page.label }, { text: page.keywords, weight: 0.7 }],
      payload: { type: "navigate", to: page.to },
      hiddenUnlessQueryIncludes: page.hidden ? "style" : undefined,
    };
  });
}

function actionItems(): PaletteItem[] {
  return [
    {
      key: "action:scan",
      group: "actions",
      label: "Start scan",
      hint: "Action",
      fields: [{ text: "Start scan" }, { text: "discover refresh run snmp", weight: 0.7 }],
      payload: { type: "action", action: "scan" },
    },
    {
      key: "action:theme",
      group: "actions",
      label: "Toggle theme",
      hint: "Action",
      fields: [{ text: "Toggle theme" }, { text: "dark light mode appearance", weight: 0.7 }],
      payload: { type: "action", action: "theme" },
    },
  ];
}

export function switchLabel(node: { sys_name?: string; hostname?: string; ip: string }): string {
  return deviceDisplayName({ ip: node.ip, sys_name: node.sys_name ?? "", hostname: node.hostname });
}

export function endpointLabel(ep: Pick<Endpoint, "hostname" | "mac">): string {
  return ep.hostname || ep.mac;
}

export function iconFor(item: PaletteItem): PaletteIcon {
  const command = item.payload;
  if (command.type === "navigate") {
    const to = command.to;
    return PAGES.find((page) => page.to === to)?.icon ?? "dashboard";
  }
  if (command.type === "action") return command.action;
  if (item.group === "ports") return "port";
  if (command.kind === "device") return "switch";
  return command.kind;
}

export function buildPaletteIndex(
  topology: TopologyData | undefined,
  endpoints: Endpoint[] | undefined,
): PaletteIndex<PaletteCommand> {
  const nodes = topology?.nodes ?? [];
  const racks = topology?.racks ?? [];

  const switches: PaletteItem[] = nodes.map((node) => ({
    key: `device:${node.id}`,
    group: "switches",
    label: switchLabel(node),
    detail: node.ip,
    hint: "Device",
    fields: [
      { text: node.hostname },
      { text: node.sys_name },
      { text: node.ip, type: "ip" },
      { text: node.mac, type: "mac" },
      { text: node.vendor, weight: 0.6 },
      { text: node.model, weight: 0.6 },
    ],
    payload: { type: "inspect", kind: "device", id: node.id },
  }));

  const endpointItems: PaletteItem[] = (endpoints ?? []).map((ep) => ({
    key: `endpoint:${ep.id}`,
    group: "endpoints",
    label: endpointLabel(ep),
    detail: [ep.ip, ep.hostname ? ep.mac : null].filter(Boolean).join("  "),
    hint: "Endpoint",
    fields: [
      { text: ep.hostname },
      { text: ep.ip, type: "ip" },
      { text: ep.mac, type: "mac" },
      { text: ep.notes, weight: 0.6 },
    ],
    payload: { type: "inspect", kind: "endpoint", id: ep.id },
  }));

  const rackItems: PaletteItem[] = racks.map((rack) => ({
    key: `rack:${rack.id}`,
    group: "racks",
    label: rack.label,
    detail: [rack.room, rack.location].filter(Boolean).join(" / ") || undefined,
    hint: "Rack",
    fields: [{ text: rack.label }, { text: rack.location, weight: 0.7 }, { text: rack.room, weight: 0.7 }],
    payload: { type: "inspect", kind: "rack", id: rack.id },
  }));

  const ports: PaletteItem[] = [];
  for (const node of nodes) {
    const name = switchLabel(node);
    for (const port of node.ports ?? []) {
      const portName = port.name || port.if_descr || port.port_id;
      if (!portName) continue;
      ports.push({
        key: `port:${node.id}:${port.port_id}`,
        group: "ports",
        label: `${name} ${portName}`,
        detail: `${node.ip}:${portName}`,
        hint: "Port",
        fields: [{ text: `${name} ${portName}` }, { text: `${node.hostname} ${portName}` }, { text: String(portName), weight: 0.8 }],
        payload: { type: "inspect", kind: "device", id: node.id },
      });
    }
  }

  return {
    pages: pageItems(),
    actions: actionItems(),
    switches,
    endpoints: endpointItems,
    racks: rackItems,
    ports,
  };
}

/** Resolve stored recent targets to palette items (unknown ids are dropped). */
export function resolveRecent(recent: InspectorTarget[], index: PaletteIndex<PaletteCommand>): PaletteItem[] {
  const byKey = new Map<string, PaletteItem>();
  for (const item of [...index.switches, ...index.endpoints, ...index.racks]) byKey.set(item.key, item);
  return recent
    .map((t) => byKey.get(`${t.kind}:${t.id}`))
    .filter((item): item is PaletteItem => item !== undefined)
    .map((item) => ({ ...item, key: `recent:${item.key}`, group: "recent" }));
}
