import { useState, useEffect, useCallback } from "react";
import { api } from "../../api.js";

function DevicesTabContent() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    api.get("/api/devices")
      .then(d => { setDevices(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => { setDevices([]); setLoading(false); });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const toggleIgnored = async (dev) => {
    setTogglingId(dev.id);
    try {
      await api.patch(`/api/topology/devices/${dev.id}/meta`, { ignored: !dev.ignored });
      api.invalidate("/api/topology", "/api/devices");
      refresh();
    } finally {
      setTogglingId(null);
    }
  };

  const toggleSelect = (id) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectAll = (devs) => setSelected(new Set(devs.map(d => d.id)));

  const bulkIgnore = async (ignored) => {
    setBulkLoading(true);
    try {
      await api.patch("/api/topology/devices/bulk-meta", {
        device_ids: [...selected], ignored
      });
      setSelected(new Set());
      api.invalidate("/api/topology", "/api/devices");
      refresh();
    } finally {
      setBulkLoading(false);
    }
  };

  const INPUT_ROW = {
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 12px",
    borderBottom: "1px solid #0f172a",
  };

  const active  = devices.filter(d => !d.ignored);
  const ignored = devices.filter(d =>  d.ignored);

  if (loading) {
    return <div style={{ color: "#475569", fontSize: 11, paddingTop: 20 }}>Loading...</div>;
  }

  if (devices.length === 0) {
    return <div style={{ color: "#475569", fontSize: 11, paddingTop: 20, textAlign: "center" }}>No devices discovered yet</div>;
  }

  const renderDevice = (dev) => {
    const portCount = (dev.ports || []).length;
    const isToggling = togglingId === dev.id;
    return (
      <div key={dev.id} style={{ ...INPUT_ROW, opacity: dev.ignored ? 0.45 : 1 }}>
        <input
          type="checkbox"
          checked={selected.has(dev.id)}
          onChange={() => toggleSelect(dev.id)}
          style={{ flexShrink: 0, cursor: "pointer", accentColor: "#22d3ee" }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: dev.ignored ? "#475569" : "#e2e8f0", fontWeight: 600, fontSize: 12 }}>
              {dev.sys_name || dev.ip}
            </span>
            <span style={{ color: "#475569", fontSize: 10 }}>{dev.ip}</span>
            {portCount > 0 ? (
              <span style={{ color: "#22d3ee", fontSize: 10, backgroundColor: "#083344", padding: "1px 5px", borderRadius: 3, border: "1px solid #164e63" }}>
                {portCount} ports
              </span>
            ) : (
              <span style={{ color: "#64748b", fontSize: 10, backgroundColor: "#0a0e18", padding: "1px 5px", borderRadius: 3, border: "1px solid #1e293b" }}>
                no ports
              </span>
            )}
            {dev.ignored && (
              <span style={{ color: "#f87171", fontSize: 10, backgroundColor: "#450a0a", padding: "1px 5px", borderRadius: 3, border: "1px solid #7f1d1d" }}>
                ignored
              </span>
            )}
          </div>
          {dev.vendor && (
            <div style={{ color: "#475569", fontSize: 10, marginTop: 2 }}>
              {dev.vendor}{dev.model ? ` — ${dev.model}` : ""}
            </div>
          )}
        </div>
        <button
          disabled={isToggling}
          onClick={() => toggleIgnored(dev)}
          title={dev.ignored ? "Re-enable this device (scan + show on map)" : "Ignore this device (skip scan, hide from map)"}
          style={{
            flexShrink: 0,
            backgroundColor: dev.ignored ? "#083344" : "#1a0a0a",
            border: dev.ignored ? "1px solid #164e63" : "1px solid #7f1d1d",
            color: dev.ignored ? "#22d3ee" : "#f87171",
            borderRadius: 5,
            padding: "4px 10px",
            cursor: isToggling ? "not-allowed" : "pointer",
            fontFamily: "'Inter', system-ui, sans-serif",
            fontSize: 10,
            fontWeight: 600,
            opacity: isToggling ? 0.6 : 1,
          }}
        >
          {isToggling ? "..." : dev.ignored ? "Re-enable" : "Ignore"}
        </button>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", paddingTop: 20, flex: 1 }}>
      <div style={{ color: "#475569", fontSize: 11 }}>
        Ignored devices are excluded from scans and hidden from the topology map.
        They remain in the database and can be re-enabled at any time.
      </div>

      {/* Bulk action toolbar */}
      {selected.size > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px", backgroundColor: "#0c1a2e",
          border: "1px solid #1e3a5f", borderRadius: 8,
        }}>
          <span style={{ color: "#7dd3fc", fontSize: 11, fontWeight: 600 }}>{selected.size} selected</span>
          <button
            disabled={bulkLoading}
            onClick={() => bulkIgnore(true)}
            style={{
              backgroundColor: "#1a0a0a", border: "1px solid #7f1d1d", color: "#f87171",
              borderRadius: 5, padding: "4px 10px", cursor: bulkLoading ? "not-allowed" : "pointer",
              fontFamily: "'Inter', system-ui, sans-serif", fontSize: 10, fontWeight: 600,
            }}
          >Ignore Selected</button>
          <button
            disabled={bulkLoading}
            onClick={() => bulkIgnore(false)}
            style={{
              backgroundColor: "#083344", border: "1px solid #164e63", color: "#22d3ee",
              borderRadius: 5, padding: "4px 10px", cursor: bulkLoading ? "not-allowed" : "pointer",
              fontFamily: "'Inter', system-ui, sans-serif", fontSize: 10, fontWeight: 600,
            }}
          >Re-enable Selected</button>
          <button
            onClick={() => setSelected(new Set())}
            style={{
              background: "none", border: "1px solid #1e293b", color: "#64748b",
              borderRadius: 5, padding: "4px 10px", cursor: "pointer",
              fontFamily: "'Inter', system-ui, sans-serif", fontSize: 10,
            }}
          >Clear</button>
        </div>
      )}

      {/* Active devices */}
      <div style={{ backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #0f172a", color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: 1, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>ACTIVE DEVICES ({active.length})</span>
          {active.length > 0 && (
            <button
              onClick={() => selectAll(active)}
              style={{ background: "none", border: "1px solid #1e293b", color: "#64748b", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 9, fontFamily: "'Inter', system-ui, sans-serif" }}
            >Select All</button>
          )}
        </div>
        {active.length === 0 ? (
          <div style={{ padding: "10px 12px", color: "#475569", fontSize: 11 }}>All devices are currently ignored</div>
        ) : (
          active.map(renderDevice)
        )}
      </div>

      {/* Ignored devices */}
      {ignored.length > 0 && (
        <div style={{ backgroundColor: "#0a0e18", border: "1px solid #3f1515", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #3f1515", color: "#f87171", fontSize: 10, fontWeight: 700, letterSpacing: 1, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>IGNORED DEVICES ({ignored.length})</span>
            {ignored.length > 0 && (
              <button
                onClick={() => selectAll(ignored)}
                style={{ background: "none", border: "1px solid #3f1515", color: "#f87171", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 9, fontFamily: "'Inter', system-ui, sans-serif" }}
              >Select All</button>
            )}
          </div>
          {ignored.map(renderDevice)}
        </div>
      )}
    </div>
  );
}

export default DevicesTabContent;
