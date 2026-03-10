import { useState, useEffect, useCallback } from "react";
import { api } from "../../api.js";

function DevicesTabContent() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [racks, setRacks]           = useState([]);
  const [classes, setClasses]       = useState([]);
  const [models, setModels]         = useState([]);
  const [editState, setEditState]   = useState({ id: null, open: false });
  const [form, setForm]             = useState({ rack_id: null, class_id: null, model_id: null });
  const [err, setErr]               = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      api.get("/api/devices"),
      api.get("/api/racks"),
      api.get("/api/switch-classes"),
      api.get("/api/switch-models"),
    ]).then(([devRes, racksRes, classesRes, modelsRes]) => {
      setDevices(devRes.status === "fulfilled" && Array.isArray(devRes.value) ? devRes.value : []);
      setRacks(racksRes.status === "fulfilled" ? racksRes.value || [] : []);
      setClasses(classesRes.status === "fulfilled" ? classesRes.value || [] : []);
      setModels(modelsRes.status === "fulfilled" ? modelsRes.value || [] : []);
      setLoading(false);
    });
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

  const resetForm = () => {
    setForm({ rack_id: null, class_id: null, model_id: null });
    setEditState({ id: null, open: false });
    setErr("");
  };

  const startEdit = (dev) => {
    setForm({
      rack_id: dev.rack_id ?? null,
      class_id: dev.class_id ?? null,
      model_id: dev.model_id ?? null,
    });
    setEditState({ id: dev.id, open: true });
    setErr("");
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      await api.patch(`/api/topology/devices/${editState.id}/meta`, {
        rack_id: form.rack_id,
        class_id: form.class_id,
        model_id: form.model_id,
      });
      api.invalidate("/api/topology", "/api/devices");
      resetForm();
      refresh();
    } catch (ex) {
      setErr(String(ex));
    }
  };

  const rackMap  = Object.fromEntries(racks.map(r => [r.id, r]));
  const classMap = Object.fromEntries(classes.map(c => [c.id, c]));
  const modelMap = Object.fromEntries(models.map(m => [m.id, m]));

  const INPUT_ROW = {
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 12px",
    borderBottom: "1px solid #0f172a",
  };

  const sel = {
    backgroundColor: "#0c0f18", border: "1px solid #1e293b", borderRadius: 5,
    color: "#e2e8f0", padding: "5px 8px",
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, lineHeight: 1.3,
    boxSizing: "border-box", width: "100%", cursor: "pointer",
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
            {dev.rack_id && rackMap[dev.rack_id] && (
              <span style={{
                color: "#a78bfa", fontSize: 10,
                backgroundColor: "#1e1035", padding: "1px 5px",
                borderRadius: 3, border: "1px solid #3b1f7e"
              }}>
                {rackMap[dev.rack_id].label}
              </span>
            )}
            {dev.class_id && classMap[dev.class_id] && (
              <span style={{
                color: classMap[dev.class_id].color || "#38bdf8", fontSize: 10,
                backgroundColor: "#0c1a2e", padding: "1px 5px",
                borderRadius: 3, border: `1px solid ${classMap[dev.class_id].color || "#1e3a5f"}`
              }}>
                {classMap[dev.class_id].label}
              </span>
            )}
            {dev.model_id && modelMap[dev.model_id] && (
              <span style={{
                color: "#fbbf24", fontSize: 10,
                backgroundColor: "#1a1500", padding: "1px 5px",
                borderRadius: 3, border: "1px solid #854d0e"
              }}>
                {modelMap[dev.model_id].name}
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
          onClick={() => startEdit(dev)}
          style={{
            flexShrink: 0,
            backgroundColor: "#0c1a2e",
            border: "1px solid #1e3a5f",
            color: "#7dd3fc",
            borderRadius: 5,
            padding: "4px 10px",
            cursor: "pointer",
            fontFamily: "'Inter', system-ui, sans-serif",
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          Edit
        </button>
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

      {editState.open && (
        <div
          onClick={e => { if (e.target === e.currentTarget) resetForm(); }}
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            backgroundColor: "rgba(2,8,23,0.75)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <form onSubmit={submitEdit} style={{
            width: 420, maxHeight: "calc(100vh - 80px)", overflowY: "auto",
            backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 12,
            padding: "20px", boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ color: "#94a3b8", fontSize: 10, letterSpacing: 1 }}>EDIT DEVICE</div>
              <button type="button" onClick={resetForm}
                style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>
                &#x2715;
              </button>
            </div>

            <div style={{ marginBottom: 12, padding: "8px 10px", backgroundColor: "#0c0f18", borderRadius: 6, border: "1px solid #1e293b" }}>
              <div style={{ color: "#e2e8f0", fontSize: 12, fontWeight: 600 }}>
                {(() => { const d = devices.find(d => d.id === editState.id); return d ? (d.sys_name || d.ip) : ""; })()}
              </div>
              <div style={{ color: "#475569", fontSize: 10 }}>
                {(() => { const d = devices.find(d => d.id === editState.id); return d?.ip || ""; })()}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
              <label style={{ fontSize: 10, color: "#94a3b8", display: "block", userSelect: "none" }}>
                Rack
                <select
                  value={form.rack_id ?? ""}
                  onChange={e => setForm(p => ({ ...p, rack_id: e.target.value ? +e.target.value : null }))}
                  style={{ ...sel, marginTop: 3 }}
                >
                  <option value="">-- No rack --</option>
                  {racks.map(r => (
                    <option key={r.id} value={r.id}>{r.label}{r.room ? ` / ${r.room}` : ""}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 10, color: "#94a3b8", display: "block", userSelect: "none" }}>
                Class
                <select
                  value={form.class_id ?? ""}
                  onChange={e => setForm(p => ({ ...p, class_id: e.target.value ? +e.target.value : null }))}
                  style={{ ...sel, marginTop: 3 }}
                >
                  <option value="">-- No class --</option>
                  {classes.map(c => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 10, color: "#94a3b8", display: "block", userSelect: "none" }}>
                Model
                <select
                  value={form.model_id ?? ""}
                  onChange={e => setForm(p => ({ ...p, model_id: e.target.value ? +e.target.value : null }))}
                  style={{ ...sel, marginTop: 3 }}
                >
                  <option value="">-- No model --</option>
                  {[...models].sort((a, b) => a.name.localeCompare(b.name)).map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </label>
            </div>

            {err && <div style={{ color: "#f87171", fontSize: 11, marginBottom: 8 }}>{err}</div>}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={resetForm}
                style={{ background: "none", border: "1px solid #1e293b", color: "#64748b", borderRadius: 5, padding: "5px 14px", cursor: "pointer", fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11 }}>
                Cancel
              </button>
              <button type="submit"
                style={{ backgroundColor: "#164e63", border: "1px solid #22d3ee", color: "#22d3ee", borderRadius: 5, padding: "5px 14px", cursor: "pointer", fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, fontWeight: 600 }}>
                Save
              </button>
            </div>
          </form>
        </div>
      )}

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
