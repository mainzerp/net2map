import type { TopologyLink } from "../../types";

interface Props {
  link: TopologyLink;
  color: string;
  onClear: () => void;
}

// ── ActiveLinkBar ────────────────────────────────────────────────────────────
function ActiveLinkBar({ link, color, onClear }: Props) {
  return (
    <div style={{
      marginBottom:10, padding:"9px 14px",
      backgroundColor:`${color}0e`, border:`1px solid ${color}44`,
      borderRadius:8, fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
      display:"flex", alignItems:"center", justifyContent:"space-between", gap:8,
    }}>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span style={{color,fontSize:14}}>{"<->"}</span>
        <span style={{color:"#e2e8f0",fontWeight:600}}>Active connection</span>
        <span style={{color:"#64748b"}}>-</span>
        <span style={{color}}>{link.local_ip}</span>
        <span style={{color:"#64748b"}}>{link.local_port}</span>
        <span style={{color:"#94a3b8"}}>{"<->"}</span>
        <span style={{color:"#64748b"}}>{link.remote_port}</span>
        <span style={{color}}>{link.remote_ip}</span>
        <span style={{padding:"1px 5px",backgroundColor:`${color}18`,border:`1px solid ${color}33`,borderRadius:4,color,fontSize:10}}>{link.speed_label}</span>
      </div>
      <button onClick={onClear} style={{background:"none",border:`1px solid ${color}44`,color,borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:11,flexShrink:0}}>X</button>
    </div>
  );
}

export { ActiveLinkBar };
export default ActiveLinkBar;
