import { useRef, useState } from "react";
import { normPort } from "../api";
import type { TopologyNode, TopologyLink, SwitchClass, SwitchModel } from "../types";
import Port from "./Port";

interface PortLinkMapEntry {
  link: TopologyLink;
  role: string;
}

interface SwitchPanelProps {
  device: TopologyNode;
  otherRacks?: { id: number; label: string }[];
  onMove?: (device: TopologyNode, rackId: number) => void;
  onUpdateMeta?: (device: TopologyNode, patch: Record<string, unknown>) => void;
  portLinkMap: Record<string, PortLinkMapEntry> | null;
  selectedLink: TopologyLink | null;
  onPortClick: ((link: TopologyLink | null) => void) | null;
  linkColorMap?: Record<string, string>;
  switchClass?: SwitchClass | null;
  switchModel?: SwitchModel | null;
  interRackPortKeys?: Set<string>;
  onShowDetail?: (deviceId: number) => void;
  highlightPortKey?: string | null;
}

// ── SwitchPanel ──────────────────────────────────────────────────────────────
export default function SwitchPanel({ device, otherRacks = [], onMove, onUpdateMeta, portLinkMap, selectedLink, onPortClick, linkColorMap, switchClass, switchModel, interRackPortKeys, onShowDetail, highlightPortKey }: SwitchPanelProps) {
  const [showMove, setShowMove] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const activePorts = device.ports.filter(p => p.oper_status === 1);
  const pingStatus = (device.ping_status as string) || "unknown";
  const statusColor = pingStatus === "online" ? "#22c55e" : pingStatus === "offline" ? "#f87171" : "#64748b";

  return (
    <div ref={panelRef} style={{
      backgroundColor:"#0f172a", border:"1px solid #1e293b",
      borderRadius:10, marginBottom:6, overflow:"visible", position:"relative",
      boxShadow:"none",
      transition:"all 0.15s",
    }}>
      <div style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"10px 14px", userSelect:"none",
      }}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div
            title={pingStatus === "online"
              ? `ping online${device.ping_rtt_ms ? ` (${device.ping_rtt_ms} ms)` : ""}`
              : pingStatus === "offline" ? "ping offline" : "ping unknown"}
            style={{width:8,height:8,borderRadius:"50%",backgroundColor:statusColor,boxShadow:`0 0 6px ${statusColor}`}}/>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{color:"#e2e8f0",fontWeight:600,fontSize:14}}>{switchModel ? switchModel.name : (device.model || device.sys_name)}</span>
              {switchClass && (
                <span style={{
                  fontSize:10, padding:"1px 6px", borderRadius:3,
                  backgroundColor:`${switchClass.color}18`,
                  border:`1px solid ${switchClass.color}44`,
                  color: switchClass.color,
                }}>{switchClass.label}</span>
              )}
            </div>
            {switchModel && <div style={{color:"#94a3b8",fontSize:11}}>{device.sys_name}</div>}
            <div style={{color:"#64748b",fontSize:12}}>
              {device.ip} - {activePorts.length}/{device.ports.length} ports active - {pingStatus}
              {pingStatus === "online" && device.ping_rtt_ms ? ` ${device.ping_rtt_ms}ms` : ""}
            </div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div
            title="Switch details"
            onClick={e => { e.stopPropagation(); onShowDetail?.(device.id); }}
            style={{
              fontSize:10, color:"#94a3b8",
              padding:"3px 8px", borderRadius:4,
              border:"1px solid #334155",
              backgroundColor:"transparent",
              cursor:"pointer", userSelect:"none",
              letterSpacing:"0.03em",
            }}
          >Details</div>
          {onMove && otherRacks.length > 0 && (
            <div
              title="Change rack"
              onClick={e => { e.stopPropagation(); setShowMove(v => !v); }}
              style={{
                fontSize:11, color: showMove ? "#22d3ee" : "#475569",
                padding:"2px 5px", borderRadius:4,
                border:`1px solid ${showMove ? "#164e63" : "#1e293b"}`,
                backgroundColor: showMove ? "#083344" : "transparent",
                cursor:"pointer", userSelect:"none",
              }}
            >{"<>"}</div>
          )}
        </div>
      </div>
      {showMove && otherRacks.length > 0 && (
        <div style={{
          padding:"6px 14px 10px", borderBottom:"1px solid #1e293b",
          backgroundColor:"#080d18",
        }}>
          <div style={{fontSize:10,color:"#475569",marginBottom:5}}>Assign to rack:</div>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {otherRacks.map(r => (
              <button
                key={r.id}
                onClick={() => { onMove!(device, r.id); setShowMove(false); }}
                style={{
                  fontSize:10, padding:"3px 10px", borderRadius:5,
                  border:"1px solid #164e63", backgroundColor:"#083344",
                  color:"#22d3ee", cursor:"pointer",
                  fontFamily:"'Inter', system-ui, sans-serif",
                }}
              >{r.label}</button>
            ))}
          </div>
        </div>
      )}

      {device.ports.length > 0 && (
        <div style={{padding:"0 14px 12px"}}>
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
                <div key={row} style={{marginBottom: row < rowCount - 1 ? 6 : 0}}>
                  <div style={{display:"flex",gap:2,alignItems:"flex-start"}}>
                    {topRow.map(port => {
                      const pKey = `${device.ip}:${normPort(port.if_descr ?? "")}`;
                      return (
                        <Port key={port.id} port={port} portKey={pKey}
                          portLinkMap={portLinkMap} selectedLink={selectedLink}
                          onPortClick={onPortClick} cableColor={linkColorMap?.[pKey]}
                          interRack={interRackPortKeys?.has(pKey)}
                          highlighted={highlightPortKey === pKey}/>
                      );
                    })}
                  </div>
                  <div style={{display:"flex",gap:2,alignItems:"flex-start",marginTop:1}}>
                    {botRow.map(port => {
                      const pKey = `${device.ip}:${normPort(port.if_descr ?? "")}`;
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
          <div style={{display:"flex",gap:14,marginTop:9,fontSize:10,color:"#475569",flexWrap:"wrap"}}>
            <span><span style={{color:"#22c55e"}}>|</span> 1G</span>
            <span><span style={{color:"#22d3ee"}}>|</span> 10G+</span>
            <span><span style={{color:"#f59e0b"}}>|</span> &lt;1G</span>
            <span><span style={{color:"#1e293b"}}>|</span> inactive</span>
          </div>
        </div>
      )}
      {device.ports.length === 0 && (
        <div style={{padding:"8px 14px 12px",color:"#334155",fontSize:11}}>No ports found - run scan</div>
      )}
    </div>
  );
}
