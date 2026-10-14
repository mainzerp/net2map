import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { extractErrorMessage } from "../api";
import useNet2MapStore from "../store";
import { useToast } from "../components/ToastProvider";
import { useScanProgress } from "../hooks/useScanProgress";
import { isScanTerminal } from "../hooks/scanEvents";
import { useInvalidateApi } from "../hooks/api/invalidate";
import { useLatencySummary } from "../hooks/api/useLatency";
import { useTopology, useUpdateDevicePosition, useUpdateRackPosition } from "../hooks/api/useTopology";
import { useSaveRack } from "../hooks/api/useRacks";
import { useUpdateDeviceMeta } from "../hooks/api/useDevices";
import TopologyCanvas, {
  type AutoLayoutAssignment,
  type DevicePositionPatch,
} from "../features/topology/TopologyCanvas";
import { buildRackPairColorMap } from "../features/topology/graph";
import {
  createFloorScope,
  findFloor,
  floorKeyOf,
  summarizeFloors,
  type FloorKey,
} from "../features/topology/floors";
import { useActiveFloor } from "../features/topology/useActiveFloor";
import RackDetail from "../components/map/RackDetail";
import { useInspector } from "../hooks/useInspector";
import { useMapBackground } from "../hooks/useMapBackground";
import { useRackOrders } from "../hooks/useRackOrders";
import type { TopologyNode, TopologyLink, SelectedRack, FilterState, TopologyData, Building } from "../types";

const EMPTY_TOPOLOGY: TopologyData = { nodes: [], links: [], racks: [], classes: [], models: [], buildings: [] };
const EMPTY_BUILDINGS: Building[] = [];

// ── MapPage ──────────────────────────────────────────────────────────────────
export default function MapPage() {
  // Live topology: 30s polling; the ETag in api.get keeps 304 responses cheap.
  const topologyQuery = useTopology({ refetchInterval: 30_000 });
  const topology = topologyQuery.data ?? EMPTY_TOPOLOGY;
  const loadError = topologyQuery.error ? extractErrorMessage(topologyQuery.error) : null;

  // Buildings/floors: one active floor at a time (URL ?floor= wins over the
  // persisted choice); no floors at all = unscoped map as before.
  const buildings = topology.buildings ?? EMPTY_BUILDINGS;
  const floorSummary = useMemo(
    () => summarizeFloors(topology.nodes, topology.racks || [], topology.classes || []),
    [topology.nodes, topology.racks, topology.classes],
  );
  const { active: activeFloor, setActive: setActiveFloor } = useActiveFloor(
    buildings,
    floorSummary.unassigned > 0,
    topologyQuery.data != null,
  );
  const activeFloorEntry = typeof activeFloor === "number" ? findFloor(buildings, activeFloor) : null;
  const { mapBgUrl, mapBgOpacity, mapBgScale, mapBgColor } = useMapBackground(activeFloorEntry?.floor ?? null);
  const selectedRack = useNet2MapStore(s => s.selectedRack);
  const setSelectedRack = useNet2MapStore(s => s.setSelectedRack);
  const highlightPortKey = useNet2MapStore(s => s.highlightPortKey);
  const clearHighlightPortKey = useNet2MapStore(s => s.clearHighlightPortKey);
  const activeScanJobId = useNet2MapStore(s => s.activeScanJobId);
  const setFocusDevice = useNet2MapStore(s => s.setFocusDevice);
  const { invalidateTopology } = useInvalidateApi();
  const { mutateAsync: patchDevicePosition } = useUpdateDevicePosition();
  const { mutateAsync: patchRackPosition } = useUpdateRackPosition();
  const { mutateAsync: saveRack } = useSaveRack();
  const { mutateAsync: patchDeviceMeta } = useUpdateDeviceMeta();
  const latencyQuery = useLatencySummary();
  const { rackOrders, reorderDevice, reorderClassSection } = useRackOrders();
  const { addToast } = useToast();

  const [filters, setFilters] = useState<FilterState>({ racks: null, classes: null });
  const [selectedLink, setSelectedLink] = useState<TopologyLink | null>(null);
  const [selectedOutsideNode, setSelectedOutsideNode] = useState<TopologyNode | null>(null);
  // Switch details open in the shared inspector drawer (app shell).
  const { open: openInspector } = useInspector();

  // When the active scan job finishes, refresh the topology immediately.
  const scanProgress = useScanProgress(activeScanJobId);
  useEffect(() => {
    if (isScanTerminal(scanProgress)) {
      invalidateTopology();
    }
  }, [scanProgress, invalidateTopology]);

  // Scan sweep overlay on the canvas while the job runs.
  const scanOverlay = useMemo(() => {
    if (!activeScanJobId || isScanTerminal(scanProgress)) return undefined;
    const total = scanProgress?.total ?? 0;
    const scanned = scanProgress?.scanned ?? scanProgress?.completed ?? 0;
    const known = scanProgress?.type === "scan_progress" && total > 0;
    return {
      active: true,
      progress: known ? scanned / total : null,
      label: known ? `Scanning ${scanned} of ${total} devices` : "Scan starting",
    };
  }, [activeScanJobId, scanProgress]);

  // Devices touched by the scan get a brief accent ring: keep each reported
  // latest_ip for a few seconds.
  const [scanPulseIps, setScanPulseIps] = useState<string[]>([]);
  const latestScanIp = scanProgress?.type === "scan_progress" ? scanProgress.latest_ip : undefined;
  const pulseTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    if (!latestScanIp) return;
    setScanPulseIps(prev => (prev.includes(latestScanIp) ? prev : [...prev.slice(-7), latestScanIp]));
    // One timer per IP (restarted if the IP repeats); deliberately not
    // cleared when the next IP arrives so every ring fades on its own.
    const timers = pulseTimersRef.current;
    const existing = timers.get(latestScanIp);
    if (existing) clearTimeout(existing);
    timers.set(latestScanIp, setTimeout(() => {
      timers.delete(latestScanIp);
      setScanPulseIps(prev => prev.filter(ip => ip !== latestScanIp));
    }, 2500));
  }, [latestScanIp]);
  useEffect(() => {
    const timers = pulseTimersRef.current;
    if (!activeScanJobId) {
      timers.forEach(t => clearTimeout(t));
      timers.clear();
      setScanPulseIps([]);
    }
  }, [activeScanJobId]);
  useEffect(() => {
    const timers = pulseTimersRef.current;
    return () => {
      timers.forEach(t => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // Switching floors closes a side panel whose rack/device is not on the
  // target floor (portal clicks and focus select the new target themselves).
  const handleActiveFloorChange = useCallback((key: FloorKey) => {
    const scope = createFloorScope(key, topology.racks || []);
    const rack = selectedRack ? (topology.racks || []).find(r => r.id === selectedRack.id) : undefined;
    if (rack && floorKeyOf(scope.rackFloor(rack)) !== key) setSelectedRack(null);
    if (selectedOutsideNode && floorKeyOf(scope.deviceFloor(selectedOutsideNode)) !== key) setSelectedOutsideNode(null);
    setActiveFloor(key);
  }, [topology.racks, selectedRack, selectedOutsideNode, setSelectedRack, setActiveFloor]);

  const selectedRackFull = useMemo(() => {
    if (!selectedRack) return null;
    const selectedRackId = Number(selectedRack.id);
    const devices = topology.nodes.filter(n => Number(n.rack_id) === selectedRackId);
    return { ...selectedRack, devices };
  }, [selectedRack, topology.nodes]);

  // Auto-select rack and clear highlight when navigating from Devices/Network page
  useEffect(() => {
    if (!highlightPortKey || !topology.nodes.length) return;
    // Key format is "<ip>:<port>" -- split on the LAST colon so IPv6
    // addresses (which contain colons) survive.
    const colonIdx = highlightPortKey.lastIndexOf(":");
    if (colonIdx < 0) return;
    const switchIp = highlightPortKey.slice(0, colonIdx);
    const node = topology.nodes.find(n => n.ip === switchIp);
    // The highlighted switch may sit on another floor: show that floor.
    if (node && activeFloor != null) {
      const key = floorKeyOf(createFloorScope(activeFloor, topology.racks || []).deviceFloor(node));
      if (key !== activeFloor) setActiveFloor(key);
    }
    if (node?.rack_id) {
      const rack = (topology.racks || []).find(r => r.id === node.rack_id);
      if (rack) {
        setSelectedRack({ ...rack, devices: [] });
      }
    }
    const timer = setTimeout(() => clearHighlightPortKey(), 3000);
    return () => clearTimeout(timer);
  }, [highlightPortKey, topology.nodes, topology.racks, setSelectedRack, clearHighlightPortKey, activeFloor, setActiveFloor]);

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
    // Pan and zoom to the device (or its rack node), like "Show on map".
    setFocusDevice(device.id);
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
    patchDevicePosition({ id, x: pos.x, y: pos.y }).catch((ex: unknown) => {
      addToast(`Position could not be saved: ${extractErrorMessage(ex)}`, "error");
    });
  }, [addToast, patchDevicePosition]);

  // Rack drag: persist the rack position and all member device positions in
  // parallel; a single toast covers any failure.
  const saveRackPosition = useCallback((rackId: number, pos: { x: number; y: number }, devicePositions: DevicePositionPatch[]) => {
    const tasks: Promise<unknown>[] = [
      patchRackPosition({ id: rackId, x: pos.x, y: pos.y }),
      ...devicePositions.map(d => patchDevicePosition({ id: d.id, x: d.x, y: d.y })),
    ];
    void Promise.allSettled(tasks).then(results => {
      const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) {
        addToast(`Position could not be saved: ${extractErrorMessage(failed.reason)}`, "error");
      }
    });
  }, [addToast, patchRackPosition, patchDevicePosition]);

  // Auto-Layout: persist every computed position, one toast on failure.
  const persistAutoLayout = useCallback((assignment: AutoLayoutAssignment) => {
    const tasks: Promise<unknown>[] = [
      ...Object.entries(assignment.racks).map(([id, p]) => patchRackPosition({ id, x: p.x, y: p.y })),
      ...Object.entries(assignment.devices).map(([id, p]) => patchDevicePosition({ id, x: p.x, y: p.y })),
    ];
    void Promise.allSettled(tasks).then(results => {
      const failed = results.filter(r => r.status === "rejected");
      if (failed.length > 0) {
        addToast(`Auto-Layout: ${failed.length} position(s) could not be saved`, "error");
      }
    });
  }, [addToast, patchRackPosition, patchDevicePosition]);

  const renameRack = async (rack: SelectedRack, newName: string) => {
    await saveRack({ id: Number(rack.id), payload: { label: newName } });
    setSelectedRack(prev => prev ? { ...prev, label: newName } : null);
  };

  const moveDevice = async (device: TopologyNode, newRackId: number | null) => {
    await patchDeviceMeta({ id: device.id, patch: { rack_id: newRackId || null } });
  };

  const updateDeviceMeta = async (device: TopologyNode, patch: Record<string, unknown>) => {
    await patchDeviceMeta({ id: device.id, patch });
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
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {loadError && (
        <div className="p-6 text-danger text-center">
          Failed to load topology: {loadError}
        </div>
      )}

      {/* Map area: flex row so the panel sits inline and the map fills the left */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
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
              onOpenDevice={(deviceId: number) => openInspector("device", deviceId)}
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
              scan={scanOverlay}
              scanPulseIps={scanPulseIps}
              latency={latencyQuery.data ?? null}
              buildings={buildings}
              activeFloor={activeFloor}
              floorCounts={floorSummary.counts}
              unassignedCount={floorSummary.unassigned}
              onActiveFloorChange={handleActiveFloorChange}
            />
          </div>
          {topology.nodes.length === 0 && !topologyQuery.isPending && (
            <p className="text-center text-muted text-[11px] mb-2">
              No devices found - add credentials in Settings and run Scan
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
              onShowDetail={(deviceId: number) => openInspector("device", deviceId)}
              highlightPortKey={highlightPortKey}
              deviceOrder={selectedRackOrders}
              onReorder={(deviceId: number, dir: "up" | "down", groupKey: string) =>
                reorderDevice(deviceId, dir, groupKey, selectedRack?.id ?? null, selectedDetail.devices)
              }
              onReorderClass={(sectionKey: string, dir: "up" | "down", sectionKeys: string[]) =>
                reorderClassSection(sectionKey, dir, selectedRack?.id ?? null, sectionKeys)
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
    </div>
  );
}
