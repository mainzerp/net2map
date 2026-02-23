import { useRef } from "react";

// ── MapSettingsTabContent ───────────────────────────────────────────────────
function MapSettingsTabContent({ url, opacity, scale, fileRef, onUpload, onRemove, onChangeOpacity, onChangeScale }) {
  const btnStyle = {
    border:"1px solid #1e293b", background:"#0f172a", color:"#94a3b8",
    borderRadius:6, padding:"6px 14px", cursor:"pointer",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
  };
  const labelStyle = { color:"#94a3b8", fontSize:11, fontFamily:"'Inter', system-ui, sans-serif" };
  const valStyle   = { color:"#64748b", fontSize:11, fontFamily:"monospace", minWidth:36 };

  return (
    <div style={{paddingTop:20, display:"flex", flexDirection:"column", gap:20, width:"100%"}}>
      <div style={{backgroundColor:"#0a0e18", border:"1px solid #1e293b", borderRadius:10, padding:16, width:"100%", boxSizing:"border-box"}}>
        <div style={{...labelStyle, fontWeight:700, marginBottom:10}}>Background Image</div>
        <div style={{display:"flex", alignItems:"center", gap:10, flexWrap:"wrap"}}>
          <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}}
            onChange={e => { if (e.target.files[0]) { onUpload(e.target.files[0]); e.target.value = ""; } }}/>
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
              onChange={e => onChangeOpacity(parseFloat(e.target.value))}
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
              onChange={e => onChangeScale(parseFloat(e.target.value))}
              style={{width:200, accentColor:"#22d3ee"}}/>
            <span style={valStyle}>{Math.round(scale*100)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default MapSettingsTabContent;
