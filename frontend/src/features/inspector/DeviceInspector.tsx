import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Container, MapPin } from "lucide-react";
import { useDevices, useTopology } from "../../hooks/api";
import { searchWithInspect, useInspector } from "../../hooks/useInspector";
import useNet2MapStore from "../../store";
import { speedLabel } from "../../theme/visual";
import { Badge, Button, StatusDot, type BadgeTone } from "../../components/ui";
import type { PortInfo } from "../../types";
import { DeviceLatencySection } from "../latency/DeviceLatencySection";
import {
  FactList,
  InspectorLoading,
  InspectorNotFound,
  InspectorSection,
  InspectorTitle,
  LinkButton,
  pingDotStatus,
  pingWord,
} from "./parts";

interface Neighbor {
  key: string;
  localPort: string;
  remoteIp: string;
  remotePort: string;
  remoteName: string;
  remoteId: number | null;
  speed?: string;
}

function portName(port: PortInfo): string {
  return port.name || port.if_descr || port.port_id;
}

// Compact STP chip: the role when known (root/designated/blocked), else the
// state; the tooltip lists role, state and path cost.
function stpTone(port: PortInfo): BadgeTone {
  if (port.stp_role === "blocked" || port.stp_state === "blocking" || port.stp_state === "broken") return "danger";
  if (port.stp_state === "listening" || port.stp_state === "learning") return "warning";
  if (port.stp_role === "root" || port.stp_role === "designated" || port.stp_state === "forwarding") return "success";
  return "neutral";
}

function StpChip({ port }: { port: PortInfo }) {
  const text = port.stp_role ?? port.stp_state;
  if (!text) return <span className="text-muted">-</span>;
  const title = [
    port.stp_role ? `Role: ${port.stp_role}` : null,
    port.stp_state ? `State: ${port.stp_state}` : null,
    port.stp_path_cost != null ? `Path cost: ${port.stp_path_cost}` : null,
  ].filter(Boolean).join(", ");
  return (
    <Badge tone={stpTone(port)} className="px-1.5 py-0 text-[9px]" title={title}>
      {text}
    </Badge>
  );
}

export default function DeviceInspector({ id, titleId }: { id: number; titleId: string }) {
  const { data, isLoading } = useTopology();
  // Ignored devices are not part of /api/topology; fall back to /api/devices.
  const devicesQuery = useDevices();
  const { open, close, raw } = useInspector();
  const navigate = useNavigate();
  const setSelectedRack = useNet2MapStore((s) => s.setSelectedRack);
  const setFocusDevice = useNet2MapStore((s) => s.setFocusDevice);

  const device = useMemo(
    () => data?.nodes.find((n) => n.id === id) ?? devicesQuery.data?.find((n) => n.id === id),
    [data, devicesQuery.data, id],
  );
  const rack = useMemo(
    () => (device?.rack_id != null ? data?.racks.find((r) => r.id === device.rack_id) : undefined),
    [data, device],
  );

  const neighbors = useMemo<Neighbor[]>(() => {
    if (!device || !data) return [];
    return data.links
      .filter((l) => l.local_ip === device.ip || l.remote_ip === device.ip)
      .map((l) => {
        const outgoing = l.local_ip === device.ip;
        const remoteIp = outgoing ? l.remote_ip : l.local_ip;
        const node = data.nodes.find((n) => n.ip === remoteIp);
        return {
          key: String(l.id),
          localPort: outgoing ? l.local_port : l.remote_port,
          remoteIp,
          remotePort: outgoing ? l.remote_port : l.local_port,
          remoteName: node?.sys_name || node?.hostname || (outgoing ? l.remote_sys_name : l.local_sys_name) || remoteIp,
          remoteId: node?.id ?? null,
          speed: l.speed_label,
        };
      })
      .sort((a, b) => a.localPort.localeCompare(b.localPort, undefined, { numeric: true }));
  }, [data, device]);

  const ports = useMemo(
    () => [...(device?.ports ?? [])].sort((a, b) => (a.if_index ?? 0) - (b.if_index ?? 0)),
    [device],
  );

  if (isLoading || (!device && devicesQuery.isLoading)) return <InspectorLoading titleId={titleId} />;
  if (!device) return <InspectorNotFound titleId={titleId} what="Switch" onClose={close} />;

  const showVlan = ports.some((p) => p.vlan != null || (p.tagged_vlans?.length ?? 0) > 0);
  const showStp = ports.some((p) => p.stp_state != null || p.stp_role != null);
  const stp = device.stp ?? null;
  const upCount = ports.filter((p) => p.oper_status === 1).length;
  const downCount = ports.length - upCount;
  const upPercent = ports.length > 0 ? Math.round((upCount / ports.length) * 100) : 0;
  const title = device.sys_name || device.hostname || device.ip;

  const showOnMap = () => {
    if (rack) setSelectedRack({ id: rack.id, label: rack.label, location: rack.location, devices: [] });
    // The topology canvas centers and zooms on this device (or its rack node)
    // and clears the focus afterwards.
    setFocusDevice(device.id);
    navigate({ pathname: "/map", search: searchWithInspect({}, raw) });
  };

  const openRack = () => {
    if (device.rack_id == null) return;
    navigate({ pathname: "/racks", search: searchWithInspect({ rack: String(device.rack_id) }, raw) });
  };

  return (
    <div>
      <div className="px-5 pt-4 pb-4 border-b border-line flex flex-col gap-2">
        <InspectorTitle id={titleId}>{title}</InspectorTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono text-muted">{device.ip}</span>
          {device.vendor && <Badge tone="neutral">{device.vendor}</Badge>}
          {device.ignored && <Badge tone="warning">Ignored</Badge>}
          <span className="inline-flex items-center gap-1.5 text-muted">
            <StatusDot status={pingDotStatus(device.ping_status)} />
            {pingWord(device.ping_status)}
            {device.ping_status === "online" && device.ping_rtt_ms != null && (
              <span className="font-mono text-[11px]">({device.ping_rtt_ms} ms)</span>
            )}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="primary" onClick={showOnMap}>
            <MapPin size={13} strokeWidth={1.75} aria-hidden="true" />
            Show on map
          </Button>
          {device.rack_id != null && (
            <Button size="sm" variant="secondary" onClick={openRack}>
              <Container size={13} strokeWidth={1.75} aria-hidden="true" />
              Open rack
            </Button>
          )}
        </div>
      </div>

      <InspectorSection title="Details">
        <FactList
          facts={[
            { label: "Hostname", value: device.hostname && device.hostname !== title ? device.hostname : null },
            { label: "Model", value: device.model },
            { label: "MAC", value: device.mac, mono: true },
            { label: "Firmware", value: device.firmware, mono: true },
            { label: "Location", value: device.location },
            {
              label: "Rack",
              value: rack ? <LinkButton onClick={() => open("rack", rack.id)}>{rack.label}</LinkButton> : null,
            },
          ]}
        />
      </InspectorSection>

      <DeviceLatencySection device={device} />

      {stp && (
        <InspectorSection title="Spanning tree">
          <FactList
            facts={[
              { label: "Protocol", value: stp.protocol === "unknown" ? "Unknown" : stp.protocol.toUpperCase() },
              { label: "Root bridge", value: stp.is_root ? "Yes" : "No" },
              { label: "Root port", value: stp.is_root ? null : stp.root_port, mono: true },
              { label: "Root cost", value: stp.root_cost != null ? String(stp.root_cost) : null, mono: true },
              { label: "Bridge ID", value: stp.bridge_id, mono: true },
              { label: "Root ID", value: stp.root_id, mono: true },
            ]}
          />
        </InspectorSection>
      )}

      <InspectorSection
        title="Ports"
        aside={
          <span className="text-[11px] text-muted">
            <span className="text-success font-semibold">{upCount} up</span>
            {" / "}
            <span>{downCount} down</span>
          </span>
        }
      >
        <div
          className="h-1.5 rounded-full bg-panel-2 overflow-hidden"
          role="img"
          aria-label={`${upCount} of ${ports.length} ports up`}
        >
          <div className="h-full bg-success rounded-full" style={{ width: `${upPercent}%` }} />
        </div>
        {ports.length > 0 ? (
          <div className="mt-3 max-h-72 overflow-y-auto border border-line rounded-control">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-panel-2">
                <tr className="text-[10px] uppercase tracking-wider text-muted">
                  <th className="px-2 py-1.5 text-left font-semibold">Port</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Status</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Speed</th>
                  {showVlan && <th className="px-2 py-1.5 text-right font-semibold">VLAN</th>}
                  {showStp && <th className="px-2 py-1.5 text-left font-semibold">STP</th>}
                  <th className="px-2 py-1.5 text-right font-semibold">Endp.</th>
                </tr>
              </thead>
              <tbody>
                {ports.map((port) => {
                  const up = port.oper_status === 1;
                  const taggedList = port.tagged_vlans ?? [];
                  const tagged = taggedList.length ? `Tagged: ${taggedList.join(", ")}` : undefined;
                  const vlanText = [
                    port.vlan != null ? String(port.vlan) : null,
                    taggedList.length ? `${taggedList.length} tagged` : null,
                  ].filter(Boolean).join(" + ") || "-";
                  return (
                    <tr key={port.id ?? port.port_id} className="border-t border-line">
                      <td className="px-2 py-1 font-mono text-primary truncate max-w-32">{portName(port)}</td>
                      <td className="px-2 py-1">
                        <span className="inline-flex items-center gap-1.5 text-muted">
                          <StatusDot status={up ? "up" : "unknown"} />
                          {up ? "Up" : "Down"}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-muted">
                        {port.speed_mbps ? speedLabel(port.speed_mbps) : "-"}
                      </td>
                      {showVlan && (
                        <td className="px-2 py-1 text-right font-mono text-muted whitespace-nowrap" title={tagged}>
                          {vlanText}
                        </td>
                      )}
                      {showStp && (
                        <td className="px-2 py-1">
                          <StpChip port={port} />
                        </td>
                      )}
                      <td className="px-2 py-1 text-right font-mono text-muted">{port.endpoint_count || 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-3 text-xs text-muted">No ports recorded</div>
        )}
      </InspectorSection>

      <InspectorSection title={`Neighbors (${neighbors.length})`}>
        {neighbors.length === 0 ? (
          <div className="text-xs text-muted">No links discovered</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {neighbors.map((n) => (
              <li key={n.key} className="flex items-center gap-2 text-xs min-w-0">
                <span className="font-mono text-[11px] text-muted shrink-0">{n.localPort}</span>
                <span className="text-muted shrink-0">to</span>
                <span className="min-w-0 truncate">
                  {n.remoteId != null ? (
                    <LinkButton onClick={() => open("device", n.remoteId as number)} title={n.remoteIp}>
                      {n.remoteName}
                    </LinkButton>
                  ) : (
                    <span className="text-primary">{n.remoteName}</span>
                  )}
                  <span className="font-mono text-[11px] text-muted"> : {n.remotePort}</span>
                </span>
                {n.speed && (
                  <Badge tone="accent" className="ml-auto shrink-0">
                    {n.speed}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
    </div>
  );
}
