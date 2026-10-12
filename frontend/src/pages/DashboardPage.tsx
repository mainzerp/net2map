import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { m } from "motion/react";
import { ArrowRight, RefreshCw, Server, Settings, Waypoints, type LucideIcon } from "lucide-react";
import { useTopology, useStats, useEndpoints, useInvalidateApi } from "../hooks/api";
import { useScanProgress } from "../hooks/useScanProgress";
import useNet2MapStore from "../store";
import { useToast } from "../components/ToastProvider";
import { Button, Card } from "../components/ui";
import { ScanHero } from "../features/dashboard/ScanHero";
import { AttentionCard } from "../features/dashboard/AttentionCard";
import { DistributionPanel } from "../features/dashboard/DistributionCards";
import { RackOverview } from "../features/dashboard/RackOverview";
import { LatencyCard } from "../features/latency/LatencyCard";
import { useLastScanRun } from "../features/dashboard/useLastScanRun";
import { api, extractErrorMessage } from "../api";
import { formatTimestamp } from "../utils/datetime";
import type { ScanProgress } from "../types";
import { revealContainerVariants, revealItemVariants, useReducedMotion } from "../theme/motion";

function DashboardSkeleton() {
  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-6 pt-6" aria-label="Loading dashboard">
      <div className="flex flex-col gap-2">
        <div className="h-3 w-24 rounded bg-panel-2 animate-pulse" />
        <div className="h-8 w-96 max-w-full rounded bg-panel-2 animate-pulse" />
        <div className="h-3 w-72 max-w-full rounded bg-panel-2 animate-pulse" />
      </div>
      <div className="h-14 rounded-card bg-panel border border-line animate-pulse" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 h-64 rounded-card bg-panel border border-line animate-pulse" />
        <div className="h-64 rounded-card bg-panel border border-line animate-pulse" />
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// Status sentence used as the page headline. Counts are emphasized; the
// sentence itself carries the meaning so status never depends on color.
function StatusHeadline({ monitored, offline }: { monitored: number; offline: number }) {
  const online = monitored - offline;
  let content: ReactNode;
  if (monitored === 0) {
    content = "No switches discovered yet.";
  } else if (offline === 0) {
    content = (
      <>
        All <strong className="font-semibold text-success tabular-nums">{monitored}</strong>{" "}
        {plural(monitored, "switch", "switches")} online.
      </>
    );
  } else {
    content = (
      <>
        <strong className="font-semibold tabular-nums">{online}</strong> {plural(online, "switch", "switches")} online.{" "}
        <strong className="font-semibold text-danger tabular-nums">{offline}</strong>{" "}
        {plural(offline, "needs", "need")} attention.
      </>
    );
  }
  return (
    <h1 className="m-0 mt-2 text-[28px] leading-tight font-normal tracking-tight text-primary">{content}</h1>
  );
}

interface FactItem {
  key: string;
  value: ReactNode;
  label: string;
  to?: string;
}

// Thin secondary line: key counts inline, separated by middots.
function FactLine({ items }: { items: FactItem[] }) {
  return (
    <p className="m-0 mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted tabular-nums">
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && <span aria-hidden="true">&middot;</span>}
          {item.to ? (
            <Link to={item.to} className="text-muted no-underline hover:text-accent">
              <span className="text-primary font-medium">{item.value}</span> {item.label}
            </Link>
          ) : (
            <span>
              {item.label} <span className="text-primary font-medium">{item.value}</span>
            </span>
          )}
        </Fragment>
      ))}
    </p>
  );
}

interface QuickLink {
  to: string;
  icon: LucideIcon;
  title: string;
  hint: string;
}

const QUICK_LINKS: QuickLink[] = [
  { to: "/map", icon: Waypoints, title: "Topology map", hint: "Rack grouping and cable tracing" },
  { to: "/devices", icon: Server, title: "Devices", hint: "Discovered endpoints and ports" },
  { to: "/settings", icon: Settings, title: "Settings", hint: "Credentials, SNMP profiles, racks" },
];

function QuickNav() {
  const navigate = useNavigate();
  return (
    <nav aria-label="Quick navigation" className="bg-panel border border-line rounded-card shadow-card overflow-hidden">
      <ul className="m-0 p-0 list-none divide-y divide-line">
        {QUICK_LINKS.map(({ to, icon: Icon, title, hint }) => (
          <li key={to}>
            <button
              type="button"
              onClick={() => navigate(to)}
              className="group w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-panel-2/60 cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <Icon size={16} strokeWidth={1.75} className="shrink-0 text-muted group-hover:text-accent" aria-hidden="true" />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-semibold text-primary">{title}</span>
                <span className="block text-[11px] text-muted truncate">{hint}</span>
              </span>
              <ArrowRight
                size={14}
                className="shrink-0 text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-transform"
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function DashboardPage() {
  const topologyQuery = useTopology();
  const statsQuery = useStats();
  const endpointsQuery = useEndpoints();
  const lastScanQuery = useLastScanRun();
  const { invalidate, invalidateTopology } = useInvalidateApi();

  const [scanning, setScanning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const activeScanJobId = useNet2MapStore((s) => s.activeScanJobId);
  const startScan = useNet2MapStore((s) => s.startScan);
  const clearScanJob = useNet2MapStore((s) => s.clearScanJob);
  const progress: ScanProgress | null = useScanProgress(activeScanJobId);
  const { addToast } = useToast();
  const reduced = useReducedMotion();
  const revealItem = revealItemVariants(reduced);

  // Handle scan completion via WebSocket: refresh all dashboard data.
  useEffect(() => {
    if (progress?.type === "scan_complete") {
      setScanning(false);
      setCancelling(false);
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

  // Uses the existing cancel endpoint (also used by Settings > Scan history).
  // Completion still arrives through the scan_complete WebSocket event.
  const handleCancelScan = async () => {
    if (!activeScanJobId) return;
    setCancelling(true);
    try {
      await api.post(`/api/scan/jobs/${activeScanJobId}/cancel`, {});
      addToast("Scan cancellation requested", "info");
    } catch (e: unknown) {
      setCancelling(false);
      addToast(extractErrorMessage(e) || "Failed to cancel scan", "error");
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
      monitoredCount: nodes.filter((n) => !n.ignored).length,
      totalPorts,
      activePorts,
      linkCount: links.length,
      rackCount: apiStats != null ? apiStats.rack_count : racks.length,
      downCount: nodes.filter((n) => !n.ignored && n.ping_status === "offline").length,
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
  const lastRun = lastScanQuery.data?.[0] ?? null;

  const facts: FactItem[] = [
    { key: "devices", value: stats.switchCount, label: plural(stats.switchCount, "device", "devices"), to: "/network" },
    { key: "endpoints", value: endpointCount ?? "-", label: plural(endpointCount ?? 0, "endpoint", "endpoints"), to: "/devices" },
    { key: "links", value: stats.linkCount, label: plural(stats.linkCount, "link", "links"), to: "/map" },
    { key: "ports", value: `${stats.activePorts}/${stats.totalPorts}`, label: "ports up", to: "/network" },
    { key: "racks", value: stats.rackCount, label: plural(stats.rackCount, "rack", "racks"), to: "/racks" },
    {
      key: "last-scan",
      value: lastRun ? formatTimestamp(lastRun.created_at) : "never",
      label: "Last scan",
    },
  ];

  return (
    // Staged reveal (header, scan bar, attention, side panels, racks) runs
    // once when the loaded dashboard mounts; refetches only re-render the
    // already visible sections, so they never replay it.
    <m.div
      variants={revealContainerVariants(reduced)}
      initial="hidden"
      animate="show"
      className="max-w-6xl mx-auto flex flex-col gap-8 pt-6 pb-12 px-1 md:px-4"
    >
      {/* Calm header: eyebrow, status sentence, key facts, compact scan bar */}
      <header className="flex flex-col gap-5">
        <m.div variants={revealItem} className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="eyebrow">Dashboard</div>
            <StatusHeadline monitored={stats.monitoredCount} offline={stats.downCount} />
            {stats.switchCount === 0 ? (
              <p className="m-0 mt-2 text-xs text-muted">Add credentials in Settings and run a scan.</p>
            ) : (
              <FactLine items={facts} />
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh dashboard"
            title="Refresh"
            onClick={() => {
              void topologyQuery.refetch();
              void statsQuery.refetch();
              void endpointsQuery.refetch();
              void lastScanQuery.refetch();
            }}
          >
            <RefreshCw size={13} aria-hidden="true" />
            Refresh
          </Button>
        </m.div>

        <m.div variants={revealItem}>
          <ScanHero
            scanning={scanning || !!activeScanJobId}
            progress={progress}
            scanError={scanError}
            lastRun={lastRun}
            onStartScan={handleStartScan}
            onCancelScan={activeScanJobId ? handleCancelScan : undefined}
            cancelling={cancelling}
          />
        </m.div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3 items-start">
        <m.div variants={revealItem} className="lg:col-span-2 min-w-0">
          <AttentionCard nodes={topology.nodes} lastRun={lastRun} />
        </m.div>
        <m.div variants={revealItem} className="flex flex-col gap-6 min-w-0">
          <LatencyCard />
          <DistributionPanel
            vendors={stats.vendors}
            switchTotal={stats.switchCount}
            speeds={stats.speeds}
            linkTotal={stats.linkCount}
          />
          <QuickNav />
        </m.div>
      </div>

      <m.div variants={revealItem}>
        <RackOverview racks={stats.rackStats} />
      </m.div>
    </m.div>
  );
}
