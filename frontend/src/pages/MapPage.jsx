import { useState, useMemo } from "react";
import { api, CABLE_COLORS } from "../api.js";
import FilterBar from "../components/map/FilterBar.jsx";
import TopologyMap from "../components/map/TopologyMap.jsx";
import RackDetail from "../components/map/RackDetail.jsx";
import SwitchDetailSlideIn from "../components/SwitchDetailSlideIn.jsx";
import { useTopologyData } from "../hooks/useTopologyData.js";
import { useMapBackground } from "../hooks/useMapBackground.js";
import { useRackOrders } from "../hooks/useRackOrders.js";

// â”€â”€ MapPage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function MapPage() {
  const { topology, selectedRack, setSelectedRack, loadError, loadTopology } = useTopologyData();
  const { mapBgUrl, mapBgNat, mapBgOpacity, mapBgScale, mapBgColor } = useMapBackground();

  // Derive the full selectedRack object (with up-to-date devices) directly from
  // topology.nodes so RackDetail and reorderDevice always see fresh data after
  // every loadTopology call.  Must be computed before useRackOrders so the hook
  // receives a rack object that actually has a .devices array.
  const selectedRackFull = useMemo(() => {
    if (!selectedRack) return null;
    const selectedRackId = Number(selectedRack.id);
    const devices = topology.nodes.filter(n => Number(n.rack_id) === selectedRackId);
    return { ...selectedRack, devices };
  }, [selectedRack, topology.nodes]);

  const { rackOrders, reorderDevice, reorderClassSection } = useRackOrders();
  const [filters, setFilters] = useState({ racks: null, classes: null });
  const [selectedLink, setSelectedLink] = useState(null);
  const [selectedOutsideNode, setSelectedOutsideNode] = useState(null);
  const [detailSwitchId, setDetailSwitchId] = useState(null);

  // Clear selected link when switching racks
  const handleSelectRack = (rack) => {
    setSelectedLink(null);
    setSelectedOutsideNode(null);
    setSelectedRack(p => p?.id === rack.id ? null : rack);
  };

  const handleSelectOutside = (node) => {
    setSelectedLink(null);
    setSelectedRack(null);
    setSelectedOutsideNode(p => p?.id === node.id ? null : node);
  };

  const allRacks = useMemo(() => {
    const rackMap = {};
    (topology.racks || []).forEach(r => {
      rackMap[r.id] = { id: r.id, label: r.label, room: r.room, description: r.description, devices: [] };
    });
    topology.nodes.forEach(n => {
      if (n.rack_id && rackMap[n.rack_id]) {
        rackMap[n.rack_id].devices.push(n);
      }
      // nodes without a rack are not shown on the map
    });
    return Object.values(rackMap);
  }, [topology.nodes, topology.racks]);

  const selectedOutsideDetail = useMemo(() => {
    if (!selectedOutsideNode) return null;
    const node = topology.nodes.find(n => n.id === selectedOutsideNode.id) || selectedOutsideNode;
    return {
      id: `outside:${node.id}`,
      label: node.sys_name || node.ip,
      location: "Outside rack",
      devices: [node],
    };
  }, [selectedOutsideNode, topology.nodes]);

  const selectedDetail = selectedRackFull || selectedOutsideDetail;

  // Assign a consistent CABLE_COLOR to each unique endpoint pair so the SVG lines
  // in TopologyMap and the port dots in RackDetail share the same color.
  // Rack endpoints keep historical keys ("<rackIdA>|<rackIdB>").
  // Outside endpoints use "outside:<deviceId>".
  const rackPairColorMap = useMemo(() => {
    const classAllowsOutside = Object.fromEntries(
      (topology.classes || []).map(c => [c.id, !!c.allow_outside_rack])
    );
    const ipToEndpoint = {};
    topology.nodes.forEach(n => {
      if (n.rack_id) {
        ipToEndpoint[n.ip] = String(n.rack_id);
      } else if (n.class_id && classAllowsOutside[n.class_id]) {
        ipToEndpoint[n.ip] = `outside:${n.id}`;
      }
    });
    const seen = {};
    let idx = 0;
    topology.links.forEach(l => {
      const a = ipToEndpoint[l.local_ip];
      const b = ipToEndpoint[l.remote_ip];
      if (!a || !b || a === b) return;
      const key = [a, b].sort().join("|");
      if (!(key in seen)) {
        seen[key] = CABLE_COLORS[idx % CABLE_COLORS.length];
        idx++;
      }
    });
    return seen;
  }, [topology.nodes, topology.links, topology.classes]);

  const savePosition = (id, x, y) => {
    api.patch(`/api/topology/devices/${id}/position`, { map_x: x, map_y: y }).catch(console.error);
  };

  const renameRack = async (rack, newName) => {
    await api.put(`/api/racks/${rack.id}`, { label: newName });
    setSelectedRack(prev => prev ? { ...prev, label: newName } : null);
    loadTopology();
  };

  const moveDevice = async (device, newRackId) => {
    await api.patch(`/api/topology/devices/${device.id}/meta`, { rack_id: newRackId || null });
    loadTopology();
  };

  const updateDeviceMeta = async (device, patch) => {
    await api.patch(`/api/topology/devices/${device.id}/meta`, patch);
    loadTopology();
  };

  // Panel width adapts to the widest switch in the rack.
  // Layout breakdown per switch row:
  //   port cell : 34px width + 2px gap = 36px per pair-column
  //   SwitchPanel inner padding : 14px left + 14px right = 28px
  //   SwitchPanel border        : 1px × 2 = 2px
  //   reorder button column     : 18px button + 5px gap = 23px
  //   RackDetail scroll-div padding: 20px left + 20px right = 40px
  //   scrollbar reserve             : 15px
  //   total overhead                : 28 + 2 + 23 + 40 + 15 = 108px
  const panelWidth = useMemo(() => {
    if (!selectedDetail) return 760;
    let maxPPR = 0;
    (selectedDetail.devices || []).forEach(d => {
      const ppr = d.ports_per_row || 24;
      if (ppr > maxPPR) maxPPR = ppr;
    });
    if (maxPPR === 0) maxPPR = 24;
    return Math.max(520, maxPPR * 36 + 108);
  }, [selectedDetail]);
  const links10g = topology.links.filter(l => ["10G","25G","40G","100G"].includes(l.speed_label)).length;
  const links1g  = topology.links.filter(l => l.speed_label === "1G").length;
  const selectedRackOrders = useMemo(() => {
    if (!selectedDetail) return {};
    const prefix = `${selectedDetail.id}::`;
    const out = {};
    Object.entries(rackOrders || {}).forEach(([k, v]) => {
      if (!k.startsWith(prefix)) return;
      out[k.slice(prefix.length)] = v;
    });
    return out;
  }, [rackOrders, selectedDetail]);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 48px)", overflow:"hidden" }}>
      {loadError && (
        <div style={{ padding: 24, color: "#e74c3c", textAlign: "center" }}>
          Failed to load topology: {loadError}
        </div>
      )}
      {/* Map toolbar */}
      <div style={{
        padding: "8px 24px", borderBottom: "1px solid #0f172a",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        backgroundColor: "#020817", fontSize: 11,
        fontFamily: "'Inter', system-ui, sans-serif",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ color: "#475569" }}><span style={{ color: "#22c55e" }}>|</span> {topology.nodes.length} Switches</span>
          <span style={{ color: "#475569" }}><span style={{ color: "#22d3ee" }}>|</span> {links10g} x {">="}10G</span>
          <span style={{ color: "#475569" }}><span style={{ color: "#334155" }}>|</span> {links1g} x 1G</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={loadTopology}
            title="Reload topology"
            style={{
              border: "1px solid #1e293b", background: "none",
              color: "#475569", borderRadius: 6, padding: "4px 10px",
              cursor: "pointer", fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11,
            }}
          >(R)</button>
        </div>
      </div>

      {/* Map area: flex row so panel sits inline and map fills the left */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
        {/* Map content column */}
        <div style={{
          flex:1, display:"flex", flexDirection:"column", overflow:"hidden",
          transition:"flex 0.25s ease",
        }}>
          <FilterBar
            racks={topology.racks || []}
            classes={topology.classes || []}
            filters={filters}
            onFilterChange={setFilters}
          />
          <div style={{
            flex:1, overflow:"hidden", borderRadius:12, margin:"0 12px 12px",
            backgroundColor: mapBgColor || "#020817",
          }}>
            <TopologyMap
              nodes={topology.nodes}
              links={topology.links}
              managedRacks={topology.racks || []}
              switchClasses={topology.classes || []}
              filters={filters}
              onSelectRack={handleSelectRack}
              onSelectOutside={handleSelectOutside}
              selectedRackId={selectedRack?.id}
              selectedOutsideId={selectedOutsideNode?.id ?? null}
              centerRackId={selectedRack?.id ?? null}
              onPositionChange={savePosition}
              mapBgUrl={mapBgUrl}
              mapBgOpacity={mapBgOpacity}
              mapBgScale={mapBgScale}
              mapBgNat={mapBgNat}
              mapBgColor={mapBgColor}
              rackPairColorMap={rackPairColorMap}
              selectedLink={selectedLink}
            />
          </div>
          {topology.nodes.length === 0 && (
            <p style={{ textAlign: "center", color: "#334155", fontSize: 11, marginBottom: 8 }}>
              No switches found - add credentials in Settings and run Scan
            </p>
          )}
        </div>

        {/* Right panel: inline, not fixed, so map shrinks gracefully */}
        {selectedDetail && (
          <div style={{ width: panelWidth, flexShrink: 0, borderLeft:"1px solid #0f172a", overflow:"hidden", display:"flex", flexDirection:"column" }}>
            <RackDetail
              rack={selectedDetail}
              allRacks={allRacks}
              switchClasses={topology.classes || []}
              switchModels={topology.models || []}
              topologyLinks={topology.links}
              rackPairColorMap={rackPairColorMap}
              selectedLink={selectedLink}
              onLinkSelect={setSelectedLink}
              onShowDetail={setDetailSwitchId}
              deviceOrder={selectedRackOrders}
              onReorder={(deviceId, dir, groupKey) =>
                reorderDevice(deviceId, dir, groupKey, selectedDetail.id, selectedDetail.devices)
              }
              onReorderClass={(sectionKey, dir, sectionKeys) =>
                reorderClassSection(sectionKey, dir, selectedDetail.id, sectionKeys)
              }
              onClose={() => {
                setSelectedRack(null);
                setSelectedOutsideNode(null);
              }}
              onRename={selectedRack ? (newName => renameRack(selectedRack, newName)) : undefined}
              onMoveDevice={moveDevice}
              onUpdateDeviceMeta={updateDeviceMeta}
            />
          </div>
        )}
      </div>
      {detailSwitchId != null && (
        <SwitchDetailSlideIn
          deviceId={detailSwitchId}
          nodes={topology.nodes}
          topologyLinks={topology.links}
          rackPairColorMap={rackPairColorMap}
          allRacks={allRacks}
          onClose={() => setDetailSwitchId(null)}
        />
      )}
    </div>
  );
}

