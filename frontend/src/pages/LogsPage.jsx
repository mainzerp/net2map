import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

export default function LogsPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [levelFilter, setLevelFilter] = useState("");
  const [limit, setLimit] = useState(300);

  const loadLogs = () => {
    const query = `/api/logs?limit=${Math.max(1, Math.min(2000, Number(limit) || 300))}${levelFilter ? `&level=${levelFilter}` : ""}`;
    api.get(query)
      .then(d => setLogs(Array.isArray(d) ? d : []))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadLogs();
  }, [levelFilter, limit]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(loadLogs, 2000);
    return () => clearInterval(t);
  }, [autoRefresh, levelFilter, limit]);

  const rows = useMemo(() => [...logs].reverse(), [logs]);

  const lvlColor = (lvl) => {
    if (lvl === "ERROR") return "#f87171";
    if (lvl === "WARNING") return "#f59e0b";
    if (lvl === "INFO") return "#22d3ee";
    return "#64748b";
  };

  return (
    <div style={{
      padding: "24px 32px",
      maxWidth: 1400,
      margin: "0 auto",
      fontFamily: "'JetBrains Mono',monospace",
      color: "#94a3b8",
    }}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,gap:12,flexWrap:"wrap"}}>
        <div>
          <div style={{color:"#e2e8f0",fontSize:20,fontWeight:700}}>Logs</div>
          <div style={{color:"#475569",fontSize:11,marginTop:4}}>Structured backend events (JSON)</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <select
            value={levelFilter}
            onChange={e => setLevelFilter(e.target.value)}
            style={{
              backgroundColor:"#0c0f18",border:"1px solid #1e293b",borderRadius:6,
              color:"#e2e8f0",padding:"6px 8px",fontFamily:"inherit",fontSize:11,
            }}
          >
            <option value="">All levels</option>
            <option value="INFO">INFO</option>
            <option value="WARNING">WARNING</option>
            <option value="ERROR">ERROR</option>
          </select>
          <input
            type="number"
            min={1}
            max={2000}
            value={limit}
            onChange={e => setLimit(e.target.value)}
            style={{
              width:90,backgroundColor:"#0c0f18",border:"1px solid #1e293b",borderRadius:6,
              color:"#e2e8f0",padding:"6px 8px",fontFamily:"inherit",fontSize:11,
            }}
          />
          <label style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#64748b"}}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            Auto refresh
          </label>
          <button
            onClick={loadLogs}
            style={{
              border:"1px solid #1e293b",background:"#0f172a",color:"#94a3b8",
              borderRadius:6,padding:"6px 10px",cursor:"pointer",fontFamily:"inherit",fontSize:11,
            }}
          >Refresh</button>
        </div>
      </div>

      <div style={{
        border:"1px solid #1e293b",borderRadius:10,backgroundColor:"#0a0e18",
        overflow:"hidden",
      }}>
        <div style={{display:"grid",gridTemplateColumns:"170px 90px 180px 1fr",gap:8,padding:"10px 12px",borderBottom:"1px solid #1e293b",fontSize:10,color:"#475569",letterSpacing:1}}>
          <span>TIME</span>
          <span>LEVEL</span>
          <span>EVENT</span>
          <span>PAYLOAD</span>
        </div>

        <div style={{maxHeight:"calc(100vh - 190px)",overflowY:"auto"}}>
          {loading ? (
            <div style={{padding:14,color:"#475569",fontSize:11}}>Loading...</div>
          ) : rows.length === 0 ? (
            <div style={{padding:14,color:"#475569",fontSize:11}}>No log entries</div>
          ) : rows.map((entry, idx) => {
            const { ts, level, event, ...payload } = entry || {};
            return (
              <div key={idx} style={{display:"grid",gridTemplateColumns:"170px 90px 180px 1fr",gap:8,padding:"8px 12px",borderBottom:"1px solid #0f172a",fontSize:10,alignItems:"start"}}>
                <span style={{color:"#64748b",whiteSpace:"nowrap"}}>{ts || "-"}</span>
                <span style={{color:lvlColor(level),fontWeight:600}}>{level || "-"}</span>
                <span style={{color:"#94a3b8",wordBreak:"break-all"}}>{event || "-"}</span>
                <span style={{color:"#7dd3fc",wordBreak:"break-word"}}>{JSON.stringify(payload)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
