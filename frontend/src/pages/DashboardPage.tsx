import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTopology, useStats, useEndpoints, useInvalidateApi } from "../hooks/api";
import { useScanProgress } from "../hooks/useScanProgress";
import useNetmapStore from "../store";
import { useToast } from "../components/ToastProvider";
import { Button, Card, EmptyState } from "../components/ui";
import { ScanHero } from "../features/dashboard/ScanHero";
import { StatCards } from "../features/dashboard/StatCards";
import { AttentionCard } from "../features/dashboard/AttentionCard";
import { VendorDistribution, LinkSpeedDistribution } from "../features/dashboard/DistributionCards";
import { RackOverview } from "../features/dashboard/RackOverview";
import { useLastScanRun } from "../features/dashboard/useLastScanRun";
import { extractErrorMessage } from "../api";
import type { ScanProgress } from "../types";

function DashboardSkeleton() {
  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-4" aria-label="Loading dashboard">
      <div className="h-8 w-56 rounded bg-panel animate-pulse" />
      <div className="h-24 rounded-lg bg-panel border border-line animate-pulse" />
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-20 rounded-lg bg-panel border border-line animate-pulse" />
        ))}
      </div>
      <div className="h-48 rounded-lg bg-panel border border-line animate-pulse" />
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const topologyQuery = useTopology();
  const statsQuery = useStats();
  const endpointsQuery = useEndpoints();
  const lastScanQuery = useLastScanRun();
  const { invalidate, invalidateTopology } = useInvalidateApi();

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const activeScanJobId = useNetmapStore((s) => s.activeScanJobId);
  const startScan = useNetmapStore((s) => s.startScan);
  const clearScanJob = useNetmapStore((s) => s.clearScanJob);
  const progress: ScanProgress | null = useScanProgress(activeScanJobId);
  const { addToast } = useToast();

  // Handle scan completion via WebSocket: refresh all dashboard data.
  useEffect(() => {
    if (progress?.type === "scan_complete") {
      setScanning(false);
      clearScanJob();
      invalidateTopology();
      invalidate(["scan-runs"]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);

  const handleStartScan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      await startScan();
      addToast("Scan started", "info");
    } catch (e: unknown) {
      setScanning(false);
      const msg = extractErrorMessage(e) || "Failed to start scan";
      setScanError(msg);
      addToast(msg, "error");
    }
  };

  const topology = topologyQuery.data ?? { nodes: [], links: [], racks: [], classes: [], models: [] };
  const apiStats = statsQuery.data ?? null;

  const stats = useMemo(() => {
    const nodes = topology.nodes || [];
    const links = topology.links || [];
    const racks = topology.racks || [];

    // Use API-provided counts when available for accuracy
    const totalPorts = apiStats != null ? apiStats.port_count : nodes.reduce((s, d) => s + d.ports.length, 0);
    const activePorts =
      apiStats != null ? apiStats.port_up_count : nodes.reduce((s, d) => s + d.ports.filter((p) => p.oper_status === 1).length, 0);

    const vendors: Record<string, number> = {};
    nodes.forEach((d) => {
      const v = d.vendor || "generic";
      vendors[v] = (vendors[v] || 0) + 1;
    });

    const speeds: Record<string, number> = {};
    links.forEach((l) => {
      const s = l.speed_label || "?";
      speeds[s] = (speeds[s] || 0) + 1;
    });

    const rackStats = racks.map((r) => {
      const devs = nodes.filter((n) => n.rack_id === r.id);
      const tp = devs.reduce((s, d) => s + d.ports.length, 0);
      const ap = devs.reduce((s, d) => s + d.ports.filter((p) => p.oper_status === 1).length, 0);
      return { id: r.id, label: r.label, room: r.room, deviceCount: devs.length, totalPorts: tp, activePorts: ap };
    });

    return {
      switchCount: apiStats != null ? apiStats.device_count : nodes.length,
      totalPorts,
      activePorts,
      linkCount: links.length,
      rackCount: apiStats != null ? apiStats.rack_count : racks.length,
      downCount: nodes.filter((n) => !n.ignored && n.ping_status === "offline").length,
      unassignedCount: nodes.filter((n) => !n.rack_id).length,
      vendors,
      speeds,
      rackStats,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyQuery.data, statsQuery.data]);

  if (topologyQuery.isLoading) return <DashboardSkeleton />;

  if (topologyQuery.isError) {
    return (
      <div className="h-full flex items-center justify-center">
        <Card className="max-w-md w-full">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="text-sm text-danger">
              Failed to load data: {extractErrorMessage(topologyQuery.error)}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void topologyQuery.refetch();
                void statsQuery.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const endpointCount = endpointsQuery.data ? endpointsQuery.data.filter((e) => !e.ignored).length : null;

  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-4">
      {/* Title row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-primary">Dashboard</h1>
          <p className="text-xs text-muted mt-0.5">Network topology overview</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void topologyQuery.refetch();
            void statsQuery.refetch();
            void endpointsQuery.refetch();
            void lastScanQuery.refetch();
          }}
        >
          Refresh
        </Button>
      </div>

      <ScanHero
        scanning={scanning || !!activeScanJobId}
        progress={progress}
        scanError={scanError}
        lastRun={lastScanQuery.data?.[0] ?? null}
        onStartScan={handleStartScan}
      />

      <StatCards
        switchCount={stats.switchCount}
        downCount={stats.downCount}
        unassignedCount={stats.unassignedCount}
        activePorts={stats.activePorts}
        totalPorts={stats.totalPorts}
        linkCount={stats.linkCount}
        rackCount={stats.rackCount}
        endpointCount={endpointCount}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <AttentionCard nodes={topology.nodes} />
        </div>
        <div className="lg:col-span-2 grid gap-4 md:grid-cols-2">
          <VendorDistribution vendors={stats.vendors} total={stats.switchCount} />
          <LinkSpeedDistribution speeds={stats.speeds} total={stats.linkCount} />
        </div>
      </div>

      <RackOverview racks={stats.rackStats} />

      {/* Quick navigation */}
      <div className="grid gap-4 md:grid-cols-2">
        <button
          type="button"
          onClick={() => navigate("/map")}
          className="text-left bg-panel border border-line rounded-lg p-4 hover:border-accent transition-colors cursor-pointer"
        >
          <div className="text-sm font-semibold text-accent">Topology Map</div>
          <div className="text-[11px] text-muted mt-1">
            Interactive network map with rack grouping and cable tracing
          </div>
        </button>
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className="text-left bg-panel border border-line rounded-lg p-4 hover:border-accent transition-colors cursor-pointer"
        >
          <div className="text-sm font-semibold text-primary">Settings</div>
          <div className="text-[11px] text-muted mt-1">
            Manage credentials, SNMP profiles, racks and device classes
          </div>
        </button>
      </div>

      {stats.switchCount === 0 && (
        <EmptyState
          title="No switches discovered yet"
          hint="Add credentials in Settings and run a scan."
        />
      )}
    </div>
  );
}
