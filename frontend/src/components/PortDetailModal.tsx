import { Link } from "react-router-dom";
import { Modal, Spinner } from "./ui";
import { speedLabel, speedColor } from "../theme/visual";
import { normPort } from "../api";
import { useEndpoints } from "../hooks/api";
import type { Endpoint, PortInfo } from "../types";

interface Props {
  port: PortInfo;
  switchIp?: string;
  onClose: () => void;
}

// Match endpoints whose found_on entries point at this switch and port.
// Port identity is matched on the DB port id when available, else on the
// normalized port name.
export function filterEndpointsForPort(
  endpoints: Endpoint[],
  switchIp: string | undefined,
  port: PortInfo,
): Endpoint[] {
  if (!switchIp) return [];
  const portName = normPort(port.if_descr || port.name || "");
  return endpoints.filter((ep) =>
    ep.found_on.some(
      (f) =>
        f.switch_ip === switchIp &&
        ((port.id != null && f.port_id === port.id) ||
          (portName !== "" && normPort(f.port_name) === portName)),
    ),
  );
}

export default function PortDetailModal({ port, switchIp, onClose }: Props) {
  const endpointCount = Number(port.endpoint_count || 0);
  const active = port.oper_status === 1;
  const { data: endpoints, isLoading } = useEndpoints();
  const matched = endpointCount > 0 ? filterEndpointsForPort(endpoints ?? [], switchIp, port) : [];

  return (
    <Modal open onClose={onClose} title={`Port ${port.if_descr || port.if_index}`} width={460}>
      {/* Port metadata */}
      <div className="grid grid-cols-[90px_1fr] gap-y-1.5 mb-4 px-3 py-2.5 bg-surface border border-line rounded-card text-xs">
        <span className="text-muted">Port</span>
        <span className="text-primary">{port.if_descr || "-"}</span>
        <span className="text-muted">Status</span>
        <span className={active ? "text-success" : "text-danger"}>{active ? "Up" : "Down"}</span>
        <span className="text-muted">Speed</span>
        <span style={{ color: speedColor(port.speed_mbps ?? 0) }}>{speedLabel(port.speed_mbps ?? 0)}</span>
        {port.vlan != null && port.vlan > 0 && (
          <>
            <span className="text-muted">VLAN</span>
            <span className="text-primary">{port.vlan}</span>
          </>
        )}
        {port.tagged_vlans && port.tagged_vlans.length > 0 && (
          <>
            <span className="text-muted">Tagged</span>
            <span className="text-primary">{port.tagged_vlans.join(", ")}</span>
          </>
        )}
        <span className="text-muted">Endpoints</span>
        <span className="text-accent">{endpointCount}</span>
      </div>

      {/* Endpoint info */}
      {endpointCount === 0 ? (
        <div className="p-2 text-muted text-[11px]">No endpoints connected to this port</div>
      ) : isLoading ? (
        <div className="p-2 text-muted text-[11px] flex items-center gap-2">
          <Spinner size={12} />
          Loading endpoints...
        </div>
      ) : matched.length > 0 ? (
        <div className="flex flex-col gap-1 mb-3">
          {matched.map((ep) => (
            <div
              key={ep.id}
              className="grid grid-cols-[130px_110px_1fr] gap-2 px-3 py-1.5 bg-surface border border-line rounded text-[11px]"
            >
              <span className="text-primary font-mono truncate">{ep.mac}</span>
              <span className="text-muted truncate">{ep.ip || "-"}</span>
              <span className="text-muted truncate">{ep.hostname || "-"}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-2 text-muted text-[11px]">
          {endpointCount} endpoint(s) connected -- no matching endpoint records loaded
        </div>
      )}
      {endpointCount > 0 && (
        <div className="p-2 text-[11px]">
          <Link to="/endpoints" className="text-accent hover:underline" onClick={onClose}>
            Open Endpoints page for full details
          </Link>
        </div>
      )}
    </Modal>
  );
}
