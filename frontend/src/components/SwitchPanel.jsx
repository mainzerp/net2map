import { useEffect, useState } from "react";
import { speedColor, VENDOR_LABEL } from "../api.js";
import Port from "./Port.jsx";

// ── SwitchPanel ──────────────────────────────────────────────────────────────
export default function SwitchPanel({ device, otherRacks = [], onMove, onUpdateMeta, portLinkMap, selectedLink, onPortClick, linkColorMap, switchClass }) {
  const [open, setOpen] = useState(true);
  const [showMove, setShowMove] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [vendorInput, setVendorInput] = useState(device.vendor || "generic");
  const [modelInput, setModelInput] = useState(device.model || "");
  const [savingMeta, setSavingMeta] = useState(false);
  const activePorts = device.ports.filter(p => p.oper_status === 1);

  useEffect(() => {
    setVendorInput(device.vendor || "generic");
    setModelInput(device.model || "");
  }, [device.id, device.vendor, device.model]);

  const saveMeta = async () => {
    if (!onUpdateMeta || savingMeta) return;
    setSavingMeta(true);
    try {
      await onUpdateMeta(device, {
        vendor: vendorInput || "generic",
        model: modelInput,
      });
      setShowEdit(false);
    } finally {
      setSavingMeta(false);
    }
  };

  return (
    <div style={{
      backgroundColor:"#0f172a", border:"1px solid #1e293b",
      borderRadius:10, marginBottom:6, overflow:"hidden",
    }}>
      <div onClick={() => setOpen(!open)} style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"10px 14px", cursor:"pointer", userSelect:"none",
      }}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",backgroundColor:"#22c55e",boxShadow:"0 0 6px #22c55e"}}/>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{color:"#e2e8f0",fontWeight:600,fontSize:14}}>{device.model || device.sys_name}</span>
              {switchClass && (
                <span style={{
                  fontSize:9, padding:"1px 6px", borderRadius:3,
                  backgroundColor:`${switchClass.color}18`,
                  border:`1px solid ${switchClass.color}44`,
                  color: switchClass.color,
                }}>{switchClass.label}</span>
              )}
            </div>
            <div style={{color:"#475569",fontSize:12}}>{device.ip} - {activePorts.length}/{device.ports.length} ports active</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          {onUpdateMeta && (
            <div
              title="Edit vendor/model"
              onClick={e => { e.stopPropagation(); setShowEdit(v => !v); }}
              style={{
                fontSize:11, color: showEdit ? "#22d3ee" : "#475569",
                padding:"2px 5px", borderRadius:4,
                border:`1px solid ${showEdit ? "#164e63" : "#1e293b"}`,
                backgroundColor: showEdit ? "#083344" : "transparent",
                cursor:"pointer", userSelect:"none",
              }}
            >ED</div>
          )}
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
          <span style={{color:"#475569",fontSize:16}}>{open ? "v" : ">"}</span>
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
                onClick={() => { onMove(device, r.id); setShowMove(false); }}
                style={{
                  fontSize:10, padding:"3px 10px", borderRadius:5,
                  border:"1px solid #164e63", backgroundColor:"#083344",
                  color:"#22d3ee", cursor:"pointer",
                  fontFamily:"'JetBrains Mono',monospace",
                }}
              >{r.label}</button>
            ))}
          </div>
        </div>
      )}

      {showEdit && onUpdateMeta && (
        <div style={{
          padding:"8px 14px 10px", borderBottom:"1px solid #1e293b",
          backgroundColor:"#080d18",
          display:"flex", alignItems:"flex-end", gap:8, flexWrap:"wrap",
        }}>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            <div style={{fontSize:10,color:"#475569"}}>Vendor</div>
            <select
              value={vendorInput}
              onChange={e => setVendorInput(e.target.value)}
              style={{
                fontSize:10, padding:"4px 6px", borderRadius:5,
                border:"1px solid #1e293b", backgroundColor:"#020817",
                color:"#94a3b8", fontFamily:"'JetBrains Mono',monospace",
              }}
            >
              <option value="aruba_cx">{VENDOR_LABEL.aruba_cx}</option>
              <option value="fs">{VENDOR_LABEL.fs}</option>
              <option value="generic">{VENDOR_LABEL.generic}</option>
            </select>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:4,minWidth:180,flex:1}}>
            <div style={{fontSize:10,color:"#475569"}}>Model</div>
            <input
              value={modelInput}
              onChange={e => setModelInput(e.target.value)}
              placeholder="e.g. Aruba CX 6100"
              style={{
                fontSize:10, padding:"4px 6px", borderRadius:5,
                border:"1px solid #1e293b", backgroundColor:"#020817",
                color:"#94a3b8", fontFamily:"'JetBrains Mono',monospace",
              }}
            />
          </div>
          <button
            onClick={saveMeta}
            disabled={savingMeta}
            style={{
              fontSize:10, padding:"4px 10px", borderRadius:5,
              border:"1px solid #164e63", backgroundColor:"#083344",
              color:"#22d3ee", cursor:savingMeta ? "default" : "pointer",
              opacity:savingMeta ? 0.65 : 1,
              fontFamily:"'JetBrains Mono',monospace",
            }}
          >{savingMeta ? "Saving..." : "Save"}</button>
        </div>
      )}

      {open && device.ports.length > 0 && (
        <div style={{padding:"0 14px 12px"}}>
          <div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"flex-start"}}>
            {device.ports.map(port => {
              const pKey = `${device.ip}:${port.if_descr}`;
              return (
                <Port
                  key={port.id}
                  port={port}
                  portKey={pKey}
                  portLinkMap={portLinkMap}
                  selectedLink={selectedLink}
                  onPortClick={onPortClick}
                  cableColor={linkColorMap?.[pKey]}
                />
              );
            })}
          </div>
          <div style={{display:"flex",gap:14,marginTop:9,fontSize:10,color:"#475569",flexWrap:"wrap"}}>
            <span><span style={{color:"#22c55e"}}>|</span> 1G</span>
            <span><span style={{color:"#22d3ee"}}>|</span> 10G+</span>
            <span><span style={{color:"#f59e0b"}}>|</span> &lt;1G</span>
            <span><span style={{color:"#1e293b"}}>|</span> inactive</span>
          </div>
        </div>
      )}
      {open && device.ports.length === 0 && (
        <div style={{padding:"8px 14px 12px",color:"#334155",fontSize:11}}>No ports found - run scan</div>
      )}
    </div>
  );
}
