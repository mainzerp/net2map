import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api, VENDOR_LABEL, VENDOR_COLOR, VENDOR_ICON } from "../api.js";
import { useScanProgress } from "../hooks/useScanProgress.js";
import useNetmapStore from "../store.js";

// ── DashboardPage ────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const navigate = useNavigate();
  const [topology, setTopology] = useState({ nodes: [], links: [], racks: [], classes: [] });
  const [apiStats, setApiStats] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);

  const activeScanJobId = useNetmapStore(s => s.activeScanJobId);
  const startScan = useNetmapStore(s => s.startScan);
  const clearScanJob = useNetmapStore(s => s.clearScanJob);
  const progress = useScanProgress(activeScanJobId);

  const loadData = () => {
    setLoading(true);
    setFetchError(null);
    Promise.allSettled([api.get("/api/topology"), api.get("/api/stats")])
      .then(([topoRes, statsRes]) => {
        if (topoRes.status === "fulfilled") setTopology(topoRes.value);
        else setFetchError(topoRes.reason?.message || "Failed to load topology");
        if (statsRes.status === "fulfilled") setApiStats(statsRes.value);
        setLoading(false);
      });
  };
  useEffect(() => { loadData(); }, []);

  // Handle scan completion via WebSocket
  useEffect(() => {
    if (progress?.type === "scan_complete") {
      setScanning(false);
      clearScanJob();
      loadData(); // refresh dashboard data after scan completes
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);

  const handleStartScan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      await startScan();
    } catch (e) {
      setScanning(false);
      setScanError(e.message || "Failed to start scan");
    }
  };

  // ── Computed stats ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const nodes = topology.nodes || [];
    const links = topology.links || [];
    const racks = topology.racks || [];

    // Use API-provided counts when available for accuracy
    const totalPorts  = apiStats != null ? apiStats.port_count  : nodes.reduce((s, d) => s + d.ports.length, 0);
    const activePorts = apiStats != null ? apiStats.port_up_count : nodes.reduce((s, d) => s + d.ports.filter(p => p.oper_status === 1).length, 0);

    // Vendor breakdown
    const vendors = {};
    nodes.forEach(d => {
      const v = d.vendor || "generic";
      vendors[v] = (vendors[v] || 0) + 1;
    });

    // Link speed breakdown
    const speeds = {};
    links.forEach(l => {
      const s = l.speed_label || "?";
      speeds[s] = (speeds[s] || 0) + 1;
    });

    // Per-rack summary
    const rackStats = racks.map(r => {
      const devs = nodes.filter(n => n.rack_id === r.id);
      const tp   = devs.reduce((s, d) => s + d.ports.length, 0);
      const ap   = devs.reduce((s, d) => s + d.ports.filter(p => p.oper_status === 1).length, 0);
      return { ...r, deviceCount: devs.length, totalPorts: tp, activePorts: ap };
    });

    const unassigned = nodes.filter(n => !n.rack_id);

    return {
      switchCount: apiStats != null ? apiStats.device_count : nodes.length,
      totalPorts,
      activePorts,
      linkCount: links.length,
      rackCount: apiStats != null ? apiStats.rack_count : racks.length,
      vendors,
      speeds,
      rackStats,
      unassignedCount: unassigned.length,
    };
  }, [topology, apiStats]);

  // ── Styles ─────────────────────────────────────────────────────────────────
  const cardStyle = {
    backgroundColor: "#0a0e18",
    border: "1px solid #1e293b",
    borderRadius: 10,
    padding: "20px 24px",
    flex: "1 1 200px",
    minWidth: 180,
  };

  const labelStyle = {
    fontSize: 10, color: "#475569", letterSpacing: "0.08em",
    textTransform: "uppercase", marginBottom: 6,
  };

  const valueStyle = {
    fontSize: 28, fontWeight: 700, color: "#e2e8f0", lineHeight: 1,
  };

  const subStyle = {
    fontSize: 11, color: "#475569", marginTop: 4,
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "calc(100vh - 48px)", color: "#475569", fontSize: 12 }}>
        Loading...
      </div>
    );
  }

  if (fetchError) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "calc(100vh - 48px)", gap: 12 }}>
        <div style={{ color: "#f87171", fontSize: 13 }}>Failed to load data: {fetchError}</div>
        <button onClick={loadData} style={{ border: "1px solid #1e293b", background: "none", color: "#94a3b8", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 11 }}>Retry</button>
      </div>
    );
  }

  return (
    <div style={{
      padding: "32px 40px", maxWidth: 1100, margin: "0 auto",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#e2e8f0" }}>Dashboard</div>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>Network topology overview</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={loadData}
            style={{
              border: "1px solid #1e293b", background: "none",
              color: "#475569", borderRadius: 6, padding: "6px 14px",
              cursor: "pointer", fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11,
            }}
          >Refresh</button>
          <button
            onClick={handleStartScan}
            disabled={scanning || !!activeScanJobId}
            style={{
              border: "1px solid #164e63",
              background: scanning ? "#0c4a6e" : "#083344",
              color: "#22d3ee", borderRadius: 6, padding: "6px 14px",
              cursor: scanning ? "default" : "pointer",
              fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, fontWeight: 600,
              opacity: scanning ? 0.7 : 1,
            }}
          >{scanning ? "Scanning..." : "Run Scan"}</button>
        </div>
      </div>

      {/* ── Scan progress ─────────────────────────────────────────────── */}
      {(scanning || activeScanJobId) && progress?.type === "scan_progress" && (
        <div style={{
          backgroundColor: "#0a0e18", border: "1px solid #164e63", borderRadius: 10,
          padding: "14px 20px", marginBottom: 28,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: "#22d3ee", fontWeight: 600 }}>
              Scanning: {progress.scanned} / {progress.total}
            </span>
            <span style={{ fontSize: 10, color: "#475569" }}>
              {progress.latest_ip}
            </span>
          </div>
          <div style={{ height: 6, backgroundColor: "#0f172a", borderRadius: 3, overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: progress.total > 0 ? `${Math.round(progress.scanned / progress.total * 100)}%` : "0%",
              backgroundColor: "#22d3ee", borderRadius: 3, transition: "width 0.3s",
            }} />
          </div>
        </div>
      )}
      {scanError && (
        <div style={{
          backgroundColor: "#0a0e18", border: "1px solid #7f1d1d", borderRadius: 10,
          padding: "14px 20px", marginBottom: 28, color: "#f87171", fontSize: 11,
        }}>
          Scan failed: {scanError}
        </div>
      )}

      {/* ── Summary cards ─────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 28 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>Switches</div>
          <div style={{ ...valueStyle, color: "#22d3ee" }}>{stats.switchCount}</div>
          {stats.unassignedCount > 0 && (
            <div style={subStyle}>{stats.unassignedCount} unassigned</div>
          )}
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Ports</div>
          <div style={valueStyle}>{stats.activePorts}<span style={{ fontSize: 14, color: "#475569", fontWeight: 400 }}> / {stats.totalPorts}</span></div>
          <div style={subStyle}>
            {stats.totalPorts > 0
              ? `${Math.round(stats.activePorts / stats.totalPorts * 100)}% active`
              : "no ports"}
          </div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Links</div>
          <div style={{ ...valueStyle, color: "#4ade80" }}>{stats.linkCount}</div>
          <div style={subStyle}>switch-to-switch</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Racks</div>
          <div style={{ ...valueStyle, color: "#a78bfa" }}>{stats.rackCount}</div>
          <div style={subStyle}>defined</div>
        </div>
      </div>

      {/* ── Two-column: Vendors + Link Speeds ─────────────────────────────── */}
      <div style={{ display: "flex", gap: 14, marginBottom: 28, flexWrap: "wrap" }}>
        {/* Vendor breakdown */}
        <div style={{ ...cardStyle, flex: "1 1 340px" }}>
          <div style={{ ...labelStyle, marginBottom: 14 }}>Vendor Breakdown</div>
          {Object.keys(stats.vendors).length === 0 ? (
            <div style={{ color: "#334155", fontSize: 11 }}>No switches discovered</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Object.entries(stats.vendors).sort((a,b) => b[1] - a[1]).map(([vendor, count]) => {
                const pct = stats.switchCount > 0 ? (count / stats.switchCount * 100) : 0;
                const color = VENDOR_COLOR[vendor] || "#475569";
                return (
                  <div key={vendor}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "#e2e8f0", display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 9, color, fontWeight: 700 }}>{VENDOR_ICON[vendor] || "[--]"}</span>
                        {VENDOR_LABEL[vendor] || vendor}
                      </span>
                      <span style={{ fontSize: 11, color: "#64748b" }}>{count} ({Math.round(pct)}%)</span>
                    </div>
                    <div style={{ height: 6, backgroundColor: "#0f172a", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, backgroundColor: color, borderRadius: 3, transition: "width 0.3s" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Link speed breakdown */}
        <div style={{ ...cardStyle, flex: "1 1 340px" }}>
          <div style={{ ...labelStyle, marginBottom: 14 }}>Link Speeds</div>
          {Object.keys(stats.speeds).length === 0 ? (
            <div style={{ color: "#334155", fontSize: 11 }}>No links discovered</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Object.entries(stats.speeds).sort((a,b) => b[1] - a[1]).map(([speed, count]) => {
                const pct = stats.linkCount > 0 ? (count / stats.linkCount * 100) : 0;
                const color =
                  speed === "100G" ? "#22d3ee" :
                  speed === "10G"  ? "#4ade80" :
                  speed === "1G"   ? "#f59e0b" : "#475569";
                return (
                  <div key={speed}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "#e2e8f0" }}>{speed}</span>
                      <span style={{ fontSize: 11, color: "#64748b" }}>{count} links ({Math.round(pct)}%)</span>
                    </div>
                    <div style={{ height: 6, backgroundColor: "#0f172a", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, backgroundColor: color, borderRadius: 3, transition: "width 0.3s" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Rack overview table ───────────────────────────────────────────── */}
      {stats.rackStats.length > 0 && (
        <div style={{ ...cardStyle, flex: "1 1 auto" }}>
          <div style={{ ...labelStyle, marginBottom: 14 }}>Racks Overview</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #1e293b", textAlign: "left" }}>
                <th style={{ padding: "8px 10px", color: "#475569", fontWeight: 600, fontSize: 9, letterSpacing: 1 }}>RACK</th>
                <th style={{ padding: "8px 10px", color: "#475569", fontWeight: 600, fontSize: 9, letterSpacing: 1 }}>ROOM</th>
                <th style={{ padding: "8px 10px", color: "#475569", fontWeight: 600, fontSize: 9, letterSpacing: 1, textAlign: "right" }}>SWITCHES</th>
                <th style={{ padding: "8px 10px", color: "#475569", fontWeight: 600, fontSize: 9, letterSpacing: 1, textAlign: "right" }}>PORTS</th>
                <th style={{ padding: "8px 10px", color: "#475569", fontWeight: 600, fontSize: 9, letterSpacing: 1, textAlign: "right" }}>ACTIVE</th>
              </tr>
            </thead>
            <tbody>
              {stats.rackStats.map(r => (
                <tr key={r.id} style={{ borderBottom: "1px solid #0f172a" }}>
                  <td style={{ padding: "8px 10px", color: "#e2e8f0", fontWeight: 600 }}>{r.label}</td>
                  <td style={{ padding: "8px 10px", color: "#475569" }}>{r.room || "-"}</td>
                  <td style={{ padding: "8px 10px", color: "#7dd3fc", textAlign: "right" }}>{r.deviceCount}</td>
                  <td style={{ padding: "8px 10px", color: "#94a3b8", textAlign: "right" }}>{r.totalPorts}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right" }}>
                    <span style={{ color: r.activePorts > 0 ? "#4ade80" : "#334155" }}>{r.activePorts}</span>
                    <span style={{ color: "#334155" }}> / {r.totalPorts}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Quick navigation ──────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 14, marginTop: 28, flexWrap: "wrap" }}>
        <button
          onClick={() => navigate("/map")}
          style={{
            flex: "1 1 200px", padding: "18px 24px", borderRadius: 10,
            backgroundColor: "#083344", border: "1px solid #164e63",
            cursor: "pointer", textAlign: "left",
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#22d3ee", marginBottom: 4 }}>Topology Map</div>
          <div style={{ fontSize: 10, color: "#475569" }}>Interactive network map with rack grouping and cable tracing</div>
        </button>
        <button
          onClick={() => navigate("/settings")}
          style={{
            flex: "1 1 200px", padding: "18px 24px", borderRadius: 10,
            backgroundColor: "#0a0e18", border: "1px solid #1e293b",
            cursor: "pointer", textAlign: "left",
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 4 }}>Settings</div>
          <div style={{ fontSize: 10, color: "#475569" }}>Manage credentials, SNMP profiles, racks and device classes</div>
        </button>
      </div>

      {/* Empty state */}
      {stats.switchCount === 0 && (
        <div style={{
          textAlign: "center", marginTop: 40, padding: 30,
          color: "#334155", fontSize: 12,
        }}>
          No switches discovered yet. Add credentials in Settings and run a scan.
        </div>
      )}
    </div>
  );
}
