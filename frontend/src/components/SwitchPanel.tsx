import { useRef, useState } from "react";
import { normPort } from "../api";
import type { TopologyNode, TopologyLink, SwitchClass, SwitchModel, PortLinkEntry } from "../types";
import Port from "./Port";

interface SwitchPanelProps {
  device: TopologyNode;
  otherRacks?: { id: number; label: string }[];
  onMove?: (device: TopologyNode, rackId: number) => void;
  onUpdateMeta?: (device: TopologyNode, patch: Record<string, unknown>) => void;
  portLinkMap: Record<string, PortLinkEntry> | null;
  selectedLink: TopologyLink | null;
  onPortClick: ((link: TopologyLink | null) => void) | null;
  linkColorMap?: Record<string, string>;
  switchClass?: SwitchClass | null;
  switchModel?: SwitchModel | null;
  interRackPortKeys?: Set<string>;
  onShowDetail?: (deviceId: number) => void;
  highlightPortKey?: string | null;
  uBadge?: string;
}

// ── SwitchPanel ──────────────────────────────────────────────────────────────
export default function SwitchPanel({ device, otherRacks = [], onMove, onUpdateMeta, portLinkMap, selectedLink, onPortClick, linkColorMap, switchClass, switchModel, interRackPortKeys, onShowDetail, highlightPortKey, uBadge }: SwitchPanelProps) {
  const [showMove, setShowMove] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const activePorts = device.ports.filter(p => p.oper_status === 1);
  const pingStatus = (device.ping_status as string) || "unknown";
  const statusColor = pingStatus === "online" ? "var(--success)" : pingStatus === "offline" ? "var(--danger)" : "var(--muted)";

  return (
    <div ref={panelRef} className="bg-panel border border-line rounded-lg mb-1.5 overflow-visible relative transition-all">
      <div className="flex items-center justify-between px-3.5 py-2.5 select-none">
        <div className="flex items-center gap-2.5">
          <div
            title={pingStatus === "online"
              ? `ping online${device.ping_rtt_ms ? ` (${device.ping_rtt_ms} ms)` : ""}`
              : pingStatus === "offline" ? "ping offline" : "ping unknown"}
            style={{ backgroundColor: statusColor, boxShadow: `0 0 6px ${statusColor}` }}
            className="w-2 h-2 rounded-full shrink-0"
          />
          <div>
            <div className="flex items-center gap-2">
              {uBadge && (
                <span className="text-[10px] px-1.5 py-px rounded border border-line-strong text-muted bg-panel-2 font-semibold shrink-0">{uBadge}</span>
              )}
              {onShowDetail ? (
                <button
                  type="button"
                  title="Open switch details"
                  onClick={e => { e.stopPropagation(); onShowDetail(device.id); }}
                  className="text-primary font-semibold text-sm text-left bg-transparent border-0 p-0 cursor-pointer hover:text-accent hover:underline underline-offset-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent rounded-sm"
                >{switchModel ? switchModel.name : (device.model || device.sys_name)}</button>
              ) : (
                <span className="text-primary font-semibold text-sm">{switchModel ? switchModel.name : (device.model || device.sys_name)}</span>
              )}
              {switchClass && (
                <span
                  className="text-[10px] px-1.5 py-px rounded border"
                  style={{
                    backgroundColor: `${switchClass.color}18`,
                    borderColor: `${switchClass.color}44`,
                    color: switchClass.color,
                  }}
                >{switchClass.label}</span>
              )}
            </div>
            {switchModel && <div className="text-muted text-[11px]">{device.sys_name}</div>}
            <div className="text-muted text-xs">
              {device.ip} - {activePorts.length}/{device.ports.length} ports active - {pingStatus}
              {pingStatus === "online" && device.ping_rtt_ms ? ` ${device.ping_rtt_ms}ms` : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title="Switch details"
            onClick={e => { e.stopPropagation(); onShowDetail?.(device.id); }}
            className="text-[10px] text-muted px-2 py-0.5 rounded border border-line-strong bg-transparent hover:text-accent hover:border-accent transition-colors cursor-pointer select-none tracking-wide"
          >Details</button>
          {onMove && otherRacks.length > 0 && (
            <button
              type="button"
              title="Change rack"
              onClick={e => { e.stopPropagation(); setShowMove(v => !v); }}
              className={`text-[11px] px-1.5 py-0.5 rounded border cursor-pointer select-none transition-colors ${
                showMove
                  ? "text-accent border-accent bg-panel-2"
                  : "text-muted border-line bg-transparent hover:text-primary"
              }`}
            >{"<>"}</button>
          )}
        </div>
      </div>
      {showMove && otherRacks.length > 0 && (
        <div className="px-3.5 pt-1.5 pb-2.5 border-b border-line bg-surface">
          <div className="text-[10px] text-muted mb-1.5">Assign to rack:</div>
          <div className="flex gap-1.5 flex-wrap">
            {otherRacks.map(r => (
              <button
                key={r.id}
                type="button"
                onClick={() => { onMove!(device, r.id); setShowMove(false); }}
                className="text-[10px] px-2.5 py-0.5 rounded border border-accent text-accent bg-panel-2 hover:bg-accent hover:text-accent-contrast transition-colors cursor-pointer"
              >{r.label}</button>
            ))}
          </div>
        </div>
      )}

      {device.ports.length > 0 && (
        <div className="px-3.5 pb-3">
          {(() => {
            const sorted = [...device.ports].sort((a, b) => (a.if_index || 0) - (b.if_index || 0));
            const cutoff = device.total_ports || sorted.length;
            const visible = sorted.slice(0, cutoff);
            const oddPorts  = visible.filter(p => (p.if_index ?? 0) % 2 === 1);
            const evenPorts = visible.filter(p => (p.if_index ?? 0) % 2 === 0);
            const maxPairs = Math.max(oddPorts.length, evenPorts.length);
            const pairsPerRow = device.ports_per_row || 24;
            const rowCount = Math.ceil(maxPairs / pairsPerRow);
            const rows: React.JSX.Element[] = [];
            for (let row = 0; row < rowCount; row++) {
              const startIdx = row * pairsPerRow;
              const endIdx   = Math.min(startIdx + pairsPerRow, maxPairs);
              const topRow   = oddPorts.slice(startIdx, endIdx);
              const botRow   = evenPorts.slice(startIdx, endIdx);
              rows.push(
                <div key={row} style={{ marginBottom: row < rowCount - 1 ? 6 : 0 }}>
                  <div className="flex gap-0.5 items-start">
                    {topRow.map(port => {
                      // Port key matches the link-side normPort(local_port):
                      // fall back to port.name when if_descr is empty so the
                      // key does not collapse to bare "<ip>:".
                      const pKey = `${device.ip}:${normPort(port.if_descr || port.name || "")}`;
                      return (
                        <Port key={port.id} port={port} portKey={pKey}
                          portLinkMap={portLinkMap} selectedLink={selectedLink}
                          onPortClick={onPortClick} cableColor={linkColorMap?.[pKey]}
                          interRack={interRackPortKeys?.has(pKey)}
                          highlighted={highlightPortKey === pKey}/>
                      );
                    })}
                  </div>
                  <div className="flex gap-0.5 items-start mt-px">
                    {botRow.map(port => {
                      const pKey = `${device.ip}:${normPort(port.if_descr || port.name || "")}`;
                      return (
                        <Port key={port.id} port={port} portKey={pKey}
                          portLinkMap={portLinkMap} selectedLink={selectedLink}
                          onPortClick={onPortClick} cableColor={linkColorMap?.[pKey]}
                          interRack={interRackPortKeys?.has(pKey)}
                          highlighted={highlightPortKey === pKey}/>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return rows;
          })()}
          <div className="flex gap-3.5 mt-2.5 text-[10px] text-muted flex-wrap">
            <span><span className="text-success">|</span> 1G</span>
            <span><span className="text-accent">|</span> 10G+</span>
            <span><span className="text-warning">|</span> &lt;1G</span>
            <span><span className="text-panel-2">|</span> inactive</span>
          </div>
        </div>
      )}
      {device.ports.length === 0 && (
        <div className="px-3.5 pt-2 pb-3 text-muted text-[11px]">No ports found - run scan</div>
      )}
    </div>
  );
}
