import { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, extractErrorMessage } from "../api";
import useNetmapStore from "../store";
import { useToast } from "../components/ToastProvider";
import { useScanProgress } from "../hooks/useScanProgress";
import { queryKeys } from "../hooks/api/keys";
import { useInvalidateApi } from "../hooks/api/invalidate";
import TopologyCanvas, {
  type AutoLayoutAssignment,
  type DevicePositionPatch,
} from "../features/topology/TopologyCanvas";
import { buildRackPairColorMap } from "../features/topology/graph";
import RackDetail from "../components/map/RackDetail";
import SwitchDetailSlideIn from "../components/SwitchDetailSlideIn";
import { useMapBackground } from "../hooks/useMapBackground";
import { useRackOrders } from "../hooks/useRackOrders";
import type { TopologyNode, TopologyLink, SelectedRack, FilterState, TopologyData } from "../types";

const EMPTY_TOPOLOGY: TopologyData = { nodes: [], links: [], racks: [], classes: [], models: [] };

// ── MapPage ──────────────────────────────────────────────────────────────────
export default function MapPage() {
  // Live topology: 30s polling; the ETag in api.get keeps 304 responses cheap.
  const topologyQuery = useQuery<TopologyData>({
    queryKey: queryKeys.topology,
    queryFn: () => api.get("/api/topology"),
    refetchInterval: 30_000,
  });
  const topology = topologyQuery.data ?? EMPTY_TOPOLOGY;
  const loadError = topologyQuery.error ? extractErrorMessage(topologyQuery.error) : null;

  const { mapBgUrl, mapBgOpacity, mapBgScale, mapBgColor } = useMapBackground();
  const selectedRack = useNetmapStore(s => s.selectedRack);
  const setSelectedRack = useNetmapStore(s => s.setSelectedRack);
  const highlightPortKey = useNetmapStore(s => s.highlightPortKey);
  const clearHighlightPortKey = useNetmapStore(s => s.clearHighlightPortKey);
  const activeScanJobId = useNetmapStore(s => s.activeScanJobId);
  const { invalidateTopology } = useInvalidateApi();
  const { rackOrders, reorderDevice, reorderClassSection } = useRackOrders();
  const { addToast } = useToast();

  const [filters, setFilters] = useState<FilterState>({ racks: null, classes: null });
  const [selectedLink, setSelectedLink] = useState<TopologyLink | null>(null);
  const [selectedOutsideNode, setSelectedOutsideNode] = useState<TopologyNode | null>(null);
  const [detailSwitchId, setDetailSwitchId] = useState<number | null>(null);

  // When the active scan job finishes, refresh the topology immediately.
  const scanProgress = useScanProgress(activeScanJobId);
  useEffect(() => {
    if (scanProgress?.type === "scan_complete") {
      invalidateTopology();
    }
  }, [scanProgress, invalidateTopology]);

  const selectedRackFull = useMemo(() => {
    if (!selectedRack) return null;
    const selectedRackId = Number(selectedRack.id);
    const devices = topology.nodes.filter(n => Number(n.rack_id) === selectedRackId);
    return { ...selectedRack, devices };
  }, [selectedRack, topology.nodes]);

  // Auto-select rack and clear highlight when navigating from Devices/Network page
  useEffect(() => {
    if (!highlightPortKey || !topology.nodes.length) return;
    const colonIdx = highlightPortKey.indexOf(":");
    if (colonIdx < 0) return;
    const switchIp = highlightPortKey.slice(0, colonIdx);
    const node = topology.nodes.find(n => n.ip === switchIp);
    if (node?.rack_id) {
      const rack = (topology.racks || []).find(r => r.id === node.rack_id);
      if (rack) {
        setSelectedRack({ ...rack, devices: [] });
      }
    }
    const timer = setTimeout(() => clearHighlightPortKey(), 3000);
    return () => clearTimeout(timer);
  }, [highlightPortKey, topology.nodes, topology.racks, setSelectedRack, clearHighlightPortKey]);

  // Clear selected link when switching racks
  const handleSelectRack = (rack: { id: number; label: string; location: string }) => {
    setSelectedLink(null);
    setSelectedOutsideNode(null);
    setSelectedRack(p => p?.id === rack.id ? null : { ...rack, devices: [] });
  };

  const handleSelectOutside = (node: TopologyNode) => {
    setSelectedLink(null);
    setSelectedRack(null);
    setSelectedOutsideNode(p => p?.id === node.id ? null : node);
  };

  // Toolbar search: racked devices select (and center) their rack, unracked
  // devices select the outside node -- same targets as clicking the canvas.
  const handleSearchSelect = (device: TopologyNode) => {
    if (device.rack_id != null) {
      const rack = (topology.racks || []).find(r => r.id === device.rack_id);
      if (rack) {
        setSelectedLink(null);
        setSelectedOutsideNode(null);
        setSelectedRack({ ...rack, devices: [] });
        return;
      }
    }
    handleSelectOutside(device);
  };

  const allRacks = useMemo(() => {
    const rackMap: Record<number, { id: number; label: string; room: string; description?: string; devices: TopologyNode[] }> = {};
    (topology.racks || []).forEach(r => {
      rackMap[r.id] = { id: r.id, label: r.label, room: r.room, description: r.description, devices: [] };
    });
    topology.nodes.forEach(n => {
      if (n.rack_id && rackMap[n.rack_id]) {
        rackMap[n.rack_id].devices.push(n);
      }
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

  const rackPairColorMap = useMemo(
    () => buildRackPairColorMap(topology.nodes, topology.links, topology.classes || []),
    [topology.nodes, topology.links, topology.classes],
  );

  // Device drag: center-convention position PATCH (unchanged contract).
  const saveDevicePosition = useCallback((id: number, pos: { x: number; y: number }) => {
    api.patch(`/api/topology/devices/${id}/position`, { map_x: pos.x, map_y: pos.y }).catch((ex: unknown) => {
      addToast(`Position could not be saved: ${extractErrorMessage(ex)}`, "error");
    });
  }, [addToast]);

  // Rack drag: persist the rack position and all member device positions in
  // parallel; a single toast covers any failure.
  const saveRackPosition = useCallback((rackId: number, pos: { x: number; y: number }, devicePositions: DevicePositionPatch[]) => {
    const tasks: Promise<unknown>[] = [
      api.patch(`/api/topology/racks/${rackId}/position`, { map_x: pos.x, map_y: pos.y }),
      ...devicePositions.map(d =>
        api.patch(`/api/topology/devices/${d.id}/position`, { map_x: d.x, map_y: d.y }),
      ),
    ];
    void Promise.allSettled(tasks).then(results => {
      const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) {
        addToast(`Position could not be saved: ${extractErrorMessage(failed.reason)}`, "error");
      }
    });
  }, [addToast]);

  // Auto-Layout: persist every computed position, one toast on failure.
  const persistAutoLayout = useCallback((assignment: AutoLayoutAssignment) => {
    const tasks: Promise<unknown>[] = [
      ...Object.entries(assignment.racks).map(([id, p]) =>
        api.patch(`/api/topology/racks/${id}/position`, { map_x: p.x, map_y: p.y }),
      ),
      ...Object.entries(assignment.devices).map(([id, p]) =>
        api.patch(`/api/topology/devices/${id}/position`, { map_x: p.x, map_y: p.y }),
      ),
    ];
    void Promise.allSettled(tasks).then(results => {
      const failed = results.filter(r => r.status === "rejected");
      if (failed.length > 0) {
        addToast(`Auto-Layout: ${failed.length} position(s) could not be saved`, "error");
      }
    });
  }, [addToast]);

  const renameRack = async (rack: SelectedRack, newName: string) => {
    await api.put(`/api/racks/${rack.id}`, { label: newName });
    setSelectedRack(prev => prev ? { ...prev, label: newName } : null);
    invalidateTopology();
  };

  const moveDevice = async (device: TopologyNode, newRackId: number | null) => {
    await api.patch(`/api/topology/devices/${device.id}/meta`, { rack_id: newRackId || null });
    invalidateTopology();
  };

  const updateDeviceMeta = async (device: TopologyNode, patch: Record<string, unknown>) => {
    await api.patch(`/api/topology/devices/${device.id}/meta`, patch);
    invalidateTopology();
  };

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

  const linkStats = useMemo(() => ({
    switches: topology.nodes.length,
    fast: topology.links.filter(l => ["10G", "25G", "40G", "100G"].includes(l.speed_label || "")).length,
    gig: topology.links.filter(l => l.speed_label === "1G").length,
  }), [topology.nodes, topology.links]);

  const selectedRackOrders = useMemo(() => {
    if (!selectedDetail) return {};
    const prefix = `${selectedDetail.id}::`;
    const out: Record<string, string[]> = {};
    Object.entries(rackOrders || {}).forEach(([k, v]) => {
      if (!k.startsWith(prefix)) return;
      out[k.slice(prefix.length)] = v;
    });
    return out;
  }, [rackOrders, selectedDetail]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 48px)", overflow: "hidden" }}>
      {loadError && (
        <div className="p-6 text-danger text-center">
          Failed to load topology: {loadError}
        </div>
      )}

      {/* Map area: flex row so the panel sits inline and the map fills the left */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden transition-all">
          <div className="flex-1 overflow-hidden rounded-xl border border-line mx-3 mb-3 mt-1">
            <TopologyCanvas
              nodes={topology.nodes}
              links={topology.links}
              managedRacks={topology.racks || []}
              switchClasses={topology.classes || []}
              filters={filters}
              onFilterChange={setFilters}
              selectedRackId={selectedRack?.id}
              selectedOutsideId={selectedOutsideNode?.id ?? null}
              onSelectRack={handleSelectRack}
              onSelectOutside={handleSelectOutside}
              onSearchSelect={handleSearchSelect}
              onRackPositionChange={saveRackPosition}
              onDevicePositionChange={saveDevicePosition}
              onAutoLayout={persistAutoLayout}
              selectedLink={selectedLink}
              rackPairColorMap={rackPairColorMap}
              mapBgUrl={mapBgUrl}
              mapBgOpacity={mapBgOpacity}
              mapBgScale={mapBgScale}
              mapBgColor={mapBgColor}
              stats={linkStats}
              updatedAt={topologyQuery.dataUpdatedAt || null}
            />
          </div>
          {topology.nodes.length === 0 && !topologyQuery.isPending && (
            <p className="text-center text-muted text-[11px] mb-2">
              No switches found - add credentials in Settings and run Scan
            </p>
          )}
        </div>

        {/* Right panel: inline, not fixed, so map shrinks gracefully */}
        {selectedDetail && (
          <div
            style={{ width: panelWidth }}
            className="shrink-0 border-l border-line overflow-hidden flex flex-col"
          >
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
              highlightPortKey={highlightPortKey}
              deviceOrder={selectedRackOrders}
              onReorder={(deviceId: number, dir: "up" | "down", groupKey: string) =>
                reorderDevice(deviceId, dir, groupKey, selectedDetail.id as number, selectedDetail.devices)
              }
              onReorderClass={(sectionKey: string, dir: "up" | "down", sectionKeys: string[]) =>
                reorderClassSection(sectionKey, dir, selectedDetail.id as number, sectionKeys)
              }
              onClose={() => {
                setSelectedRack(null);
                setSelectedOutsideNode(null);
              }}
              onRename={selectedRack ? ((newName: string) => renameRack(selectedRack, newName)) : undefined}
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
