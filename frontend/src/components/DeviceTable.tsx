import { useState, useEffect, useCallback } from "react";
import { api, extractErrorMessage } from "../api";
import { useToast } from "./ToastProvider";
import type { DeviceTableProps, RackInfo, SwitchClass, SwitchModel } from "../types";

interface DeviceRecord {
  id: number;
  sys_name?: string;
  ip: string;
  mac?: string;
  vendor?: string;
  model?: string;
  ignored: boolean;
  rack_id?: number | null;
  class_id?: number | null;
  model_id?: number | null;
}

interface EditState {
  id: number | null;
  open: boolean;
}

interface FormState {
  rack_id: number | null;
  class_id: number | null;
  model_id: number | null;
}

interface SortState {
  column: string | null;
  direction: "asc" | "desc" | null;
}

interface ColumnDef {
  key: string;
  label: string;
}

export default function DeviceTable({ title, subtitle, activeLabel, ignoredLabel, emptyMessage }: DeviceTableProps) {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [racks, setRacks] = useState<RackInfo[]>([]);
  const [classes, setClasses] = useState<SwitchClass[]>([]);
  const [models, setModels] = useState<SwitchModel[]>([]);
  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm] = useState<FormState>({ rack_id: null, class_id: null, model_id: null });
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: null, direction: null });
  const { addToast } = useToast();

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

  const invalidateAll = () => {
    api.invalidate("/api/topology", "/api/devices");
  };

  const toggleIgnored = async (dev: DeviceRecord) => {
    setTogglingId(dev.id);
    try {
      await api.patch(`/api/topology/devices/${dev.id}/meta`, { ignored: !dev.ignored });
      invalidateAll();
      refresh();
    } catch (ex) {
      addToast(`Failed to update device: ${extractErrorMessage(ex)}`, "error");
    } finally {
      setTogglingId(null);
    }
  };

  const toggleSelect = (id: number) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectAll = (devs: DeviceRecord[]) => setSelected(new Set(devs.map(d => d.id)));

  const bulkIgnore = async (ignored: boolean) => {
    setBulkLoading(true);
    try {
      await api.patch("/api/topology/devices/bulk-meta", {
        device_ids: [...selected], ignored
      });
      setSelected(new Set());
      invalidateAll();
      refresh();
    } catch (ex) {
      addToast(`Failed to update devices: ${extractErrorMessage(ex)}`, "error");
    } finally {
      setBulkLoading(false);
    }
  };

  const resetForm = () => {
    setForm({ rack_id: null, class_id: null, model_id: null });
    setEditState({ id: null, open: false });
    setErr("");
  };

  const startEdit = (dev: DeviceRecord) => {
    setForm({
      rack_id: dev.rack_id ?? null,
      class_id: dev.class_id ?? null,
      model_id: dev.model_id ?? null,
    });
    setEditState({ id: dev.id, open: true });
    setErr("");
  };

  const submitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      await api.patch(`/api/topology/devices/${editState.id}/meta`, {
        rack_id: form.rack_id,
        class_id: form.class_id,
        model_id: form.model_id,
      });
      invalidateAll();
      resetForm();
      refresh();
    } catch (ex) {
      setErr(extractErrorMessage(ex));
    }
  };

  const rackMap = Object.fromEntries(racks.map(r => [r.id, r]));
  const classMap = Object.fromEntries(classes.map(c => [c.id, c]));
  const modelMap = Object.fromEntries(models.map(m => [m.id, m]));

  /* ---- Search ---- */
  const getSearchableText = (dev: DeviceRecord) => {
    const parts = [
      dev.sys_name || "",
      dev.ip || "",
      dev.mac || "",
      dev.rack_id && rackMap[dev.rack_id] ? rackMap[dev.rack_id].label : "",
      dev.class_id && classMap[dev.class_id] ? classMap[dev.class_id].label : "",
      dev.model_id && modelMap[dev.model_id] ? modelMap[dev.model_id].name : "",
      dev.vendor || "",
    ];
    return parts.join(" ").toLowerCase();
  };

  const filtered = search
    ? devices.filter(d => getSearchableText(d).includes(search.toLowerCase()))
    : devices;

  /* ---- Sort ---- */
  const cycleSort = (column: string) => {
    setSort(prev => {
      if (prev.column !== column) return { column, direction: "asc" as const };
      if (prev.direction === "asc") return { column, direction: "desc" as const };
      return { column: null, direction: null };
    });
  };

  const getSortValue = (dev: DeviceRecord, column: string): string => {
    switch (column) {
      case "name": return (dev.sys_name || dev.ip || "").toLowerCase();
      case "ip": return dev.ip || "";
      case "mac": return (dev.mac || "").toLowerCase();
      case "rack": return (dev.rack_id && rackMap[dev.rack_id] ? rackMap[dev.rack_id].label : "").toLowerCase();
      case "class": return (dev.class_id && classMap[dev.class_id] ? classMap[dev.class_id].label : "").toLowerCase();
      case "model": return (dev.model_id && modelMap[dev.model_id] ? modelMap[dev.model_id].name : "").toLowerCase();
      default: return "";
    }
  };

  const sortDevices = (list: DeviceRecord[]): DeviceRecord[] => {
    if (!sort.column) return list;
    const sorted = [...list].sort((a, b) => {
      const va = getSortValue(a, sort.column!);
      const vb = getSortValue(b, sort.column!);
      if (va < vb) return -1;
      if (va > vb) return 1;
      return 0;
    });
    return sort.direction === "desc" ? sorted.reverse() : sorted;
  };

  const active = filtered.filter(d => !d.ignored);
  const ignored = filtered.filter(d => d.ignored);
  const sortedActive = sortDevices(active);
  const sortedIgnored = sortDevices(ignored);

  /* ---- Styles ---- */
  const sel: React.CSSProperties = {
    backgroundColor: "#0c0f18", border: "1px solid #1e293b", borderRadius: 5,
    color: "#e2e8f0", padding: "5px 8px",
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, lineHeight: 1.3,
    boxSizing: "border-box", width: "100%", cursor: "pointer",
  };

  const tableStyle: React.CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: 11,
  };

  const thBase: React.CSSProperties = {
    position: "sticky",
    top: 0,
    backgroundColor: "#0a0e18",
    color: "#64748b",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.5,
    textAlign: "left",
    padding: "7px 8px",
    borderBottom: "1px solid #1e293b",
    userSelect: "none",
    whiteSpace: "nowrap",
    zIndex: 1,
  };

  const tdBase: React.CSSProperties = {
    padding: "6px 8px",
    borderBottom: "1px solid #0f172a",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 180,
    verticalAlign: "middle",
  };

  const searchInputStyle: React.CSSProperties = {
    backgroundColor: "#0c0f18",
    border: "1px solid #1e293b",
    borderRadius: 5,
    color: "#e2e8f0",
    padding: "6px 10px",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: 11,
    width: 280,
    outline: "none",
    boxSizing: "border-box",
  };

  /* ---- Column defs ---- */
  const allColumns: ColumnDef[] = [
    { key: "name",  label: "Name" },
    { key: "ip",    label: "IP" },
    { key: "mac",   label: "MAC" },
    { key: "rack",  label: "Rack" },
    { key: "class", label: "Class" },
    { key: "model", label: "Model" },
  ];
  const columns = allColumns;

  const renderSortArrow = (colKey: string) => {
    if (sort.column !== colKey) return null;
    return (
      <span style={{ marginLeft: 3, fontSize: 9, color: "#22d3ee" }}>
        {sort.direction === "asc" ? "\u25B2" : "\u25BC"}
      </span>
    );
  };

  const renderHead = () => (
    <thead>
      <tr>
        <th style={{ ...thBase, cursor: "default", width: 30 }} />
        {columns.map(col => (
          <th key={col.key} onClick={() => cycleSort(col.key)} style={{ ...thBase, cursor: "pointer" }}>
            {col.label}{renderSortArrow(col.key)}
          </th>
        ))}
        <th style={{ ...thBase, cursor: "default", textAlign: "right" }}>Actions</th>
      </tr>
    </thead>
  );

  const renderRow = (dev: DeviceRecord) => {
    const isToggling = togglingId === dev.id;
    return (
      <tr key={dev.id} style={{ opacity: dev.ignored ? 0.45 : 1 }}>
        <td style={tdBase}>
          <input
            type="checkbox"
            checked={selected.has(dev.id)}
            onChange={() => toggleSelect(dev.id)}
            style={{ cursor: "pointer", accentColor: "#22d3ee" }}
          />
        </td>
        <td style={{ ...tdBase, color: dev.ignored ? "#475569" : "#e2e8f0", fontWeight: 600, fontSize: 12, maxWidth: 220 }}>
          {dev.sys_name || dev.ip}
          {dev.vendor && (
            <div style={{ color: "#475569", fontSize: 10, fontWeight: 400, marginTop: 1 }}>
              {dev.vendor}{dev.model ? ` -- ${dev.model}` : ""}
            </div>
          )}
        </td>
        <td style={{ ...tdBase, color: "#94a3b8", fontFamily: "monospace", fontSize: 11 }}>
          {dev.ip}
        </td>
        <td style={{ ...tdBase, color: "#64748b", fontFamily: "monospace" }}>
          {dev.mac || ""}
        </td>
        <td style={tdBase}>
          {(() => {
            const rId = dev.rack_id || null;
            if (!rId || !rackMap[rId]) return null;
            return (
              <span style={{
                color: "#a78bfa", fontSize: 10,
                backgroundColor: "#1e1035", padding: "1px 5px",
                borderRadius: 3, border: "1px solid #3b1f7e",
              }}>
                {rackMap[rId].label}
              </span>
            );
          })()}
        </td>
        <td style={tdBase}>
          {dev.class_id && classMap[dev.class_id] && (
            <span style={{
              color: classMap[dev.class_id].color || "#38bdf8", fontSize: 10,
              backgroundColor: "#0c1a2e", padding: "1px 5px",
              borderRadius: 3, border: `1px solid ${classMap[dev.class_id].color || "#1e3a5f"}`,
            }}>
              {classMap[dev.class_id].label}
            </span>
          )}
        </td>
        <td style={tdBase}>
          {dev.model_id && modelMap[dev.model_id] && (
            <span style={{
              color: "#fbbf24", fontSize: 10,
              backgroundColor: "#1a1500", padding: "1px 5px",
              borderRadius: 3, border: "1px solid #854d0e",
            }}>
              {modelMap[dev.model_id].name}
            </span>
          )}
        </td>
        <td style={{ ...tdBase, textAlign: "right", whiteSpace: "nowrap" }}>
          <div style={{ display: "inline-flex", gap: 4 }}>
            <button
              onClick={() => startEdit(dev)}
              style={{
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
            >Edit</button>
            <button
              disabled={isToggling}
              onClick={() => toggleIgnored(dev)}
              title={dev.ignored ? "Re-enable this device (scan + show on map)" : "Ignore this device (skip scan, hide from map)"}
              style={{
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
            >{isToggling ? "..." : dev.ignored ? "Re-enable" : "Ignore"}</button>
          </div>
        </td>
      </tr>
    );
  };

  const renderSection = (label: string, list: DeviceRecord[], borderColor: string, headerColor: string, allDevs: DeviceRecord[]) => (
    <div style={{ backgroundColor: "#0a0e18", border: `1px solid ${borderColor}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{
        padding: "8px 12px", borderBottom: `1px solid ${borderColor}`,
        color: headerColor, fontSize: 10, fontWeight: 700, letterSpacing: 1,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span>{label} ({list.length})</span>
        {allDevs.length > 0 && (
          <button
            onClick={() => selectAll(allDevs)}
            style={{
              background: "none", border: `1px solid ${borderColor}`,
              color: headerColor, borderRadius: 4, padding: "2px 8px",
              cursor: "pointer", fontSize: 9, fontFamily: "'Inter', system-ui, sans-serif",
            }}
          >Select All</button>
        )}
      </div>
      {list.length === 0 ? (
        <div style={{ padding: "10px 12px", color: "#475569", fontSize: 11 }}>
          All devices are currently ignored
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            {renderHead()}
            <tbody>
              {list.map(renderRow)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div style={{
      padding: "24px 32px",
      maxWidth: 1400,
      margin: "0 auto",
      fontFamily: "'Inter', system-ui, sans-serif",
      color: "#94a3b8",
    }}>
      {/* Page title */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 18 }}>{title}</div>
        <div style={{ color: "#64748b", fontSize: 12, marginTop: 3 }}>{subtitle}</div>
        <div style={{ height: 1, backgroundColor: "#0f172a", marginTop: 14 }} />
      </div>

      {loading && (
        <div style={{ color: "#475569", fontSize: 11, paddingTop: 20 }}>Loading...</div>
      )}

      {!loading && devices.length === 0 && (
        <div style={{ color: "#475569", fontSize: 11, paddingTop: 20, textAlign: "center" }}>{emptyMessage}</div>
      )}

      {!loading && devices.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ color: "#475569", fontSize: 11 }}>
            Ignored devices are excluded from scans and hidden from the topology map.
            They remain in the database and can be re-enabled at any time.
          </div>

          {/* Edit modal */}
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
                        <option key={r.id} value={r.id}>{r.label}{(r as RackInfo & { room?: string }).room ? ` / ${(r as RackInfo & { room?: string }).room}` : ""}</option>
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

          {/* Search */}
          <div>
            <input
              type="text"
              placeholder="Search devices..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={searchInputStyle}
            />
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

          {/* Active section */}
          {renderSection(activeLabel, sortedActive, "#1e293b", "#94a3b8", active)}

          {/* Ignored section */}
          {sortedIgnored.length > 0 && renderSection(ignoredLabel, sortedIgnored, "#3f1515", "#f87171", ignored)}
        </div>
      )}
    </div>
  );
}
