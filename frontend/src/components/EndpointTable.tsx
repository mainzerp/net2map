import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api, normPort, extractErrorMessage } from "../api";
import { useToast } from "./ToastProvider";
import useNetmapStore from "../store";
import type { Endpoint } from "../types";

interface SortState {
  column: string | null;
  direction: "asc" | "desc" | null;
}

export default function EndpointTable() {
  const navigate = useNavigate();
  const setSelectedRack = useNetmapStore(s => s.setSelectedRack);
  const setHighlightPortKey = useNetmapStore(s => s.setHighlightPortKey);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: null, direction: null });
  const { addToast } = useToast();

  const refresh = useCallback(() => {
    setLoading(true);
    api.get("/api/endpoints").then((data: Endpoint[]) => {
      setEndpoints(Array.isArray(data) ? data : []);
      setLoading(false);
    }).catch(() => {
      setEndpoints([]);
      setLoading(false);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const invalidateAll = () => {
    api.invalidate("/api/endpoints");
  };

  const toggleIgnored = async (ep: Endpoint) => {
    setTogglingId(ep.id);
    try {
      await api.patch(`/api/endpoints/${ep.id}`, { ignored: !ep.ignored });
      invalidateAll();
      refresh();
    } catch (ex) {
      addToast(`Failed to update endpoint: ${extractErrorMessage(ex)}`, "error");
    } finally {
      setTogglingId(null);
    }
  };

  const toggleSelect = (id: number) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectAll = (eps: Endpoint[]) => setSelected(new Set(eps.map(e => e.id)));

  const bulkIgnore = async (ignored: boolean) => {
    setBulkLoading(true);
    try {
      await api.patch("/api/endpoints/bulk", {
        endpoint_ids: [...selected], ignored
      });
      setSelected(new Set());
      invalidateAll();
      refresh();
    } catch (ex) {
      addToast(`Failed to update endpoints: ${extractErrorMessage(ex)}`, "error");
    } finally {
      setBulkLoading(false);
    }
  };

  const goToPort = (ep: Endpoint) => {
    const fo = ep.found_on?.[0];
    if (!fo) return;
    const portKey = `${fo.switch_ip}:${normPort(fo.port_name || "")}`;
    setHighlightPortKey(portKey);
    navigate("/map");
  };

  /* ---- Search ---- */
  const getSearchableText = (ep: Endpoint) => {
    const parts = [
      ep.mac || "",
      ep.ip || "",
      ep.hostname || "",
      ep.notes || "",
      ...ep.found_on.map(fo => `${fo.switch_name} ${fo.switch_ip} ${fo.port_name}`),
    ];
    return parts.join(" ").toLowerCase();
  };

  const filtered = search
    ? endpoints.filter(e => getSearchableText(e).includes(search.toLowerCase()))
    : endpoints;

  /* ---- Sort ---- */
  const cycleSort = (column: string) => {
    setSort(prev => {
      if (prev.column !== column) return { column, direction: "asc" as const };
      if (prev.direction === "asc") return { column, direction: "desc" as const };
      return { column: null, direction: null };
    });
  };

  const getSortValue = (ep: Endpoint, column: string): string => {
    switch (column) {
      case "mac": return (ep.mac || "").toLowerCase();
      case "ip": return ep.ip || "";
      case "hostname": return (ep.hostname || "").toLowerCase();
      case "first_seen": return ep.first_seen || "";
      case "last_seen": return ep.last_seen || "";
      case "port": {
        const fo = ep.found_on?.[0];
        return fo ? `${fo.switch_name || fo.switch_ip}:${fo.port_name}`.toLowerCase() : "";
      }
      default: return "";
    }
  };

  const sortEndpoints = (list: Endpoint[]): Endpoint[] => {
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

  const active = filtered.filter(e => !e.ignored);
  const ignored = filtered.filter(e => e.ignored);
  const sortedActive = sortEndpoints(active);
  const sortedIgnored = sortEndpoints(ignored);

  /* ---- Styles ---- */
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

  const columns = [
    { key: "mac",        label: "MAC" },
    { key: "ip",         label: "IP" },
    { key: "hostname",   label: "Hostname" },
    { key: "first_seen", label: "First Seen" },
    { key: "last_seen",  label: "Last Seen" },
    { key: "port",       label: "Found On" },
  ];

  const renderSortArrow = (colKey: string) => {
    if (sort.column !== colKey) return null;
    return (
      <span style={{ marginLeft: 3, fontSize: 9, color: "#22d3ee" }}>
        {sort.direction === "asc" ? "\u25B2" : "\u25BC"}
      </span>
    );
  };

  const formatTimestamp = (ts: string | null) => {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    } catch {
      return ts;
    }
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

  const renderRow = (ep: Endpoint) => {
    const isToggling = togglingId === ep.id;
    const fo = ep.found_on?.[0];
    return (
      <tr key={ep.id} style={{ opacity: ep.ignored ? 0.45 : 1 }}>
        <td style={tdBase}>
          <input
            type="checkbox"
            checked={selected.has(ep.id)}
            onChange={() => toggleSelect(ep.id)}
            style={{ cursor: "pointer", accentColor: "#22d3ee" }}
          />
        </td>
        <td style={{ ...tdBase, color: ep.ignored ? "#475569" : "#e2e8f0", fontWeight: 600, fontSize: 12, fontFamily: "monospace" }}>
          {ep.mac}
        </td>
        <td style={{ ...tdBase, color: "#94a3b8", fontFamily: "monospace", fontSize: 11 }}>
          {ep.ip || ""}
        </td>
        <td style={{ ...tdBase, color: "#94a3b8" }}>
          {ep.hostname || ""}
        </td>
        <td style={{ ...tdBase, color: "#64748b", fontSize: 10 }}>
          {formatTimestamp(ep.first_seen)}
        </td>
        <td style={{ ...tdBase, color: "#64748b", fontSize: 10 }}>
          {formatTimestamp(ep.last_seen)}
        </td>
        <td style={tdBase}>
          {fo && fo.switch_ip && (
            <span
              onClick={(e) => { e.stopPropagation(); goToPort(ep); }}
              title={`Found on ${fo.switch_name || fo.switch_ip} port ${fo.port_name}`}
              style={{
                color: "#38bdf8", fontSize: 10,
                backgroundColor: "#0c1a2e", padding: "1px 5px",
                borderRadius: 3, border: "1px solid #1e3a5f",
                cursor: "pointer",
                display: "inline-flex", alignItems: "center", gap: 3,
              }}
            >
              {fo.switch_name || fo.switch_ip}:{fo.port_name}
            </span>
          )}
        </td>
        <td style={{ ...tdBase, textAlign: "right", whiteSpace: "nowrap" }}>
          <div style={{ display: "inline-flex", gap: 4 }}>
            <button
              disabled={isToggling}
              onClick={() => toggleIgnored(ep)}
              title={ep.ignored ? "Re-enable this endpoint" : "Ignore this endpoint"}
              style={{
                backgroundColor: ep.ignored ? "#083344" : "#1a0a0a",
                border: ep.ignored ? "1px solid #164e63" : "1px solid #7f1d1d",
                color: ep.ignored ? "#22d3ee" : "#f87171",
                borderRadius: 5,
                padding: "4px 10px",
                cursor: isToggling ? "not-allowed" : "pointer",
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 10,
                fontWeight: 600,
                opacity: isToggling ? 0.6 : 1,
              }}
            >{isToggling ? "..." : ep.ignored ? "Re-enable" : "Ignore"}</button>
          </div>
        </td>
      </tr>
    );
  };

  const renderSection = (label: string, list: Endpoint[], borderColor: string, headerColor: string, allEps: Endpoint[]) => (
    <div style={{ backgroundColor: "#0a0e18", border: `1px solid ${borderColor}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{
        padding: "8px 12px", borderBottom: `1px solid ${borderColor}`,
        color: headerColor, fontSize: 10, fontWeight: 700, letterSpacing: 1,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span>{label} ({list.length})</span>
        {allEps.length > 0 && (
          <button
            onClick={() => selectAll(allEps)}
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
          All endpoints are currently ignored
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
      <div style={{ marginBottom: 20 }}>
        <div style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 18 }}>Devices</div>
        <div style={{ color: "#64748b", fontSize: 12, marginTop: 3 }}>End devices discovered on the network (not managed switches)</div>
        <div style={{ height: 1, backgroundColor: "#0f172a", marginTop: 14 }} />
      </div>

      {loading && (
        <div style={{ color: "#475569", fontSize: 11, paddingTop: 20 }}>Loading...</div>
      )}

      {!loading && endpoints.length === 0 && (
        <div style={{ color: "#475569", fontSize: 11, paddingTop: 20, textAlign: "center" }}>No endpoint devices discovered yet</div>
      )}

      {!loading && endpoints.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ color: "#475569", fontSize: 11 }}>
            Ignored endpoints are excluded from display. They remain in the database and can be re-enabled at any time.
          </div>

          {/* Search */}
          <div>
            <input
              type="text"
              placeholder="Search endpoints..."
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
          {renderSection("ACTIVE ENDPOINTS", sortedActive, "#1e293b", "#94a3b8", active)}

          {/* Ignored section */}
          {sortedIgnored.length > 0 && renderSection("IGNORED ENDPOINTS", sortedIgnored, "#3f1515", "#f87171", ignored)}
        </div>
      )}
    </div>
  );
}
