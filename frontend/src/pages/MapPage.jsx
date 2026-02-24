import { useState, useMemo } from "react";
import { api, CABLE_COLORS } from "../api.js";
import FilterBar from "../components/map/FilterBar.jsx";
import TopologyMap from "../components/map/TopologyMap.jsx";
import RackDetail from "../components/map/RackDetail.jsx";
import { useTopologyData } from "../hooks/useTopologyData.js";
import { useMapBackground } from "../hooks/useMapBackground.js";
import { useRackOrders } from "../hooks/useRackOrders.js";

// â”€â”€ MapPage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function MapPage() {
  const { topology, selectedRack, setSelectedRack, loadError, loadTopology } = useTopologyData();
  const { mapBgUrl, mapBgNat, mapBgOpacity, mapBgScale } = useMapBackground();
  const { rackOrders, reorderDevice } = useRackOrders(selectedRack);
  const [filters, setFilters] = useState({ racks: null, classes: null });
  const [selectedLink, setSelectedLink] = useState(null);

  // Clear selected link when switching racks
  const handleSelectRack = (rack) => {
    setSelectedLink(null);
    setSelectedRack(p => p?.id === rack.id ? null : rack);
  };

  const allRacks = useMemo(() => {
    const rackMap = {};
    (topology.racks || []).forEach(r => {
      rackMap[r.id] = { id: r.id, label: r.label, room: r.room, description: r.description, devices: [] };
    });
    const unassigned = { id: "__unassigned__", label: "Unassigned", room: "", description: "", devices: [] };
    topology.nodes.forEach(n => {
      if (n.rack_id && rackMap[n.rack_id]) {
        rackMap[n.rack_id].devices.push(n);
      } else {
        unassigned.devices.push(n);
      }
    });
    const result = Object.values(rackMap);
    if (unassigned.devices.length > 0) result.push(unassigned);
    return result;
  }, [topology.nodes, topology.racks]);

  // Derive the full selectedRack object (with up-to-date devices) directly from
  // topology.nodes so RackDetail always sees fresh data after every loadTopology call.
  const selectedRackFull = useMemo(() => {
    if (!selectedRack) return null;
    const devices = topology.nodes.filter(n => n.rack_id === selectedRack.id);
    return { ...selectedRack, devices };
  }, [selectedRack, topology.nodes]);

  // Assign a consistent CABLE_COLOR to each unique rack-pair so the SVG lines
  // in TopologyMap and the port dots in RackDetail share the same color.
  // Key: "<rackIdA>|<rackIdB>" (sorted), Value: color string.
  const rackPairColorMap = useMemo(() => {
    const ipToRack = {};
    topology.nodes.forEach(n => {
      ipToRack[n.ip] = n.rack_id ? String(n.rack_id) : "__unassigned__";
    });
    const seen = {};
    let idx = 0;
    topology.links.forEach(l => {
      const ra = ipToRack[l.local_ip];
      const rb = ipToRack[l.remote_ip];
      if (!ra || !rb || ra === rb) return;
      const key = [ra, rb].sort().join("|");
      if (!(key in seen)) {
        seen[key] = CABLE_COLORS[idx % CABLE_COLORS.length];
        idx++;
      }
    });
    return seen;
  }, [topology.nodes, topology.links]);

  const savePosition = (id, x, y) => {
    api.patch(`/api/topology/devices/${id}/position`, { map_x: x, map_y: y }).catch(console.error);
  };

  const renameRack = async (rack, newName) => {
    if (rack.id === "__unassigned__") return;
    await api.put(`/api/racks/${rack.id}`, { label: newName });
    setSelectedRack(prev => prev ? { ...prev, label: newName } : null);
    loadTopology();
  };

  const moveDevice = async (device, newRackId) => {
    const rId = newRackId === "__unassigned__" ? null : newRackId;
    await api.patch(`/api/topology/devices/${device.id}/meta`, { rack_id: rId });
    loadTopology();
  };

  const updateDeviceMeta = async (device, patch) => {
    await api.patch(`/api/topology/devices/${device.id}/meta`, patch);
    loadTopology();
  };

  const panelOpen = !!selectedRack;
  const links10g = topology.links.filter(l => ["10G","25G","40G","100G"].includes(l.speed_label)).length;
  const links1g  = topology.links.filter(l => l.speed_label === "1G").length;

  return (
    <>
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

      <div style={{ padding: 24, marginRight: panelOpen ? 760 : 0, transition: "margin-right 0.25s ease" }}>
        <FilterBar
          racks={topology.racks || []}
          classes={topology.classes || []}
          filters={filters}
          onFilterChange={setFilters}
        />
        <div style={{ border: "1px solid #0f172a", borderRadius: 12, overflow: "hidden" }}>
          <TopologyMap
            nodes={topology.nodes}
            links={topology.links}
            managedRacks={topology.racks || []}
            switchClasses={topology.classes || []}
            filters={filters}
            onSelectRack={handleSelectRack}
            selectedRackId={selectedRack?.id}
            onPositionChange={savePosition}
            mapBgUrl={mapBgUrl}
            mapBgOpacity={mapBgOpacity}
            mapBgScale={mapBgScale}
            mapBgNat={mapBgNat}
            rackPairColorMap={rackPairColorMap}
            selectedLink={selectedLink}
          />
        </div>
        {topology.nodes.length === 0 && (
          <p style={{ textAlign: "center", color: "#334155", fontSize: 11, marginTop: 12 }}>
            No switches found - add credentials in Settings and run Scan
          </p>
        )}
      </div>

      {selectedRackFull && (
        <RackDetail
          rack={selectedRackFull}
          allRacks={allRacks}
          switchClasses={topology.classes || []}
          switchModels={topology.models || []}
          topologyLinks={topology.links}
          rackPairColorMap={rackPairColorMap}
          selectedLink={selectedLink}
          onLinkSelect={setSelectedLink}
          deviceOrder={selectedRack ? Object.fromEntries(
            ["tor","access","other"].map(g => [
              g, rackOrders[`${selectedRack.id}::${g}`]
            ])
          ) : {}}
          onReorder={(deviceId, dir, groupKey) => reorderDevice(deviceId, dir, groupKey)}
          onClose={() => setSelectedRack(null)}
          onRename={newName => renameRack(selectedRack, newName)}
          onMoveDevice={moveDevice}
          onUpdateDeviceMeta={updateDeviceMeta}
        />
      )}
    </>
  );
}

