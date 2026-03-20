import React from "react";

interface MapSettingsTabContentProps {
  url: string | null;
  opacity: number;
  scale: number;
  bgColor: string;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (file: File) => void;
  onRemove: () => void;
  onChangeOpacity: (val: number) => void;
  onChangeScale: (val: number) => void;
  onChangeBgColor: (val: string) => void;
  loading: boolean;
  error: string;
}

// ── MapSettingsTabContent ───────────────────────────────────────────────────
function MapSettingsTabContent({ url, opacity, scale, bgColor, fileRef, onUpload, onRemove, onChangeOpacity, onChangeScale, onChangeBgColor, loading, error }: MapSettingsTabContentProps) {
  const btnStyle: React.CSSProperties = {
    border:"1px solid #1e293b", background:"#0f172a", color:"#94a3b8",
    borderRadius:6, padding:"6px 14px", cursor:"pointer",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
  };
  const labelStyle: React.CSSProperties = { color:"#94a3b8", fontSize:11, fontFamily:"'Inter', system-ui, sans-serif" };
  const valStyle: React.CSSProperties   = { color:"#64748b", fontSize:11, fontFamily:"monospace", minWidth:36 };

  return (
    <div style={{paddingTop:20, display:"flex", flexDirection:"column", gap:20, width:"100%"}}>
      {loading && (
        <div style={{color:"#64748b", fontSize:11, padding:"12px 0"}}>Loading map settings...</div>
      )}
      {error && (
        <div style={{color:"#f87171", fontSize:11, padding:"8px 12px", backgroundColor:"#1c1917", border:"1px solid #7f1d1d", borderRadius:6, marginBottom:8}}>
          {error}
        </div>
      )}
      <div style={{backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:10, padding:16, width:"100%", boxSizing:"border-box"}}>
        <div style={{...labelStyle, fontWeight:700, marginBottom:10}}>Map Background Color</div>
        <div style={{display:"flex", alignItems:"center", gap:12}}>
          <input
            type="color"
            value={bgColor || "#020817"}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChangeBgColor(e.target.value)}
            style={{ width:40, height:32, border:"1px solid #1e293b", borderRadius:4, cursor:"pointer", padding:2, backgroundColor:"transparent" }}
          />
          <span style={{...valStyle, fontFamily:"monospace"}}>{bgColor || "#020817"}</span>
          <button
            onClick={() => onChangeBgColor("#020817")}
            style={{...btnStyle, fontSize:10, padding:"4px 10px"}}
          >Reset dark</button>
          <button
            onClick={() => onChangeBgColor("#ffffff")}
            style={{...btnStyle, fontSize:10, padding:"4px 10px"}}
          >White</button>
        </div>
        <div style={{...labelStyle, fontSize:10, color:"#475569", marginTop:8}}>
          Set to match your floor plan or office background for a seamless look.
        </div>
      </div>
      <div style={{backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:10, padding:16, width:"100%", boxSizing:"border-box"}}>
        <div style={{...labelStyle, fontWeight:700, marginBottom:10}}>Background Image</div>
        <div style={{display:"flex", alignItems:"center", gap:10, flexWrap:"wrap"}}>
          <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files?.[0]) { onUpload(e.target.files[0]); e.target.value = ""; } }}/>
          <button onClick={() => fileRef.current?.click()} style={btnStyle}>
            {url ? "Replace image" : "Upload image"}
          </button>
          {url && (
            <button onClick={onRemove}
              style={{...btnStyle, border:"1px solid #7f1d1d", background:"#1c1917", color:"#f87171"}}>
              Remove
            </button>
          )}
        </div>
        {url && (
          <div style={{marginTop:12, borderRadius:8, border:"1px solid #1e293b", overflow:"hidden", maxWidth:400}}>
            <img src={url} alt="Background preview" style={{display:"block", width:"100%", opacity:0.8}}/>
          </div>
        )}
      </div>
      {url && (
        <div style={{marginTop:14}}>
          <div style={{...labelStyle, marginBottom:6}}>Opacity</div>
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            <input type="range" min="0.05" max="1" step="0.05" value={opacity}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChangeOpacity(parseFloat(e.target.value))}
              style={{width:200, accentColor:"#22d3ee"}}/>
            <span style={valStyle}>{Math.round(opacity*100)}%</span>
          </div>
        </div>
      )}
      {url && (
        <div style={{marginTop:14}}>
          <div style={{...labelStyle, marginBottom:6}}>Image Zoom</div>
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            <input type="range" min="0.1" max="5" step="0.1" value={scale}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChangeScale(parseFloat(e.target.value))}
              style={{width:200, accentColor:"#22d3ee"}}/>
            <span style={valStyle}>{Math.round(scale*100)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default MapSettingsTabContent;
