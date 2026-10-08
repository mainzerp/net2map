import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { useLatencyHistory, useLatencySummary } from "../../hooks/api";
import { useInspector } from "../../hooks/useInspector";
import { extractErrorMessage } from "../../api";
import { formatRelativeTime } from "../../utils/datetime";
import { Badge, Sparkline, Spinner } from "../../components/ui";
import type { LatencyDevice, LatencyRange } from "../../types";
import { RangeSwitch } from "./RangeSwitch";
import { formatMs, formatPct, isProblemStatus, latencyBadgeTone, latencyStatusLabel } from "./latency";

// Dashboard card for the latency monitor: network-wide median / p95 / loss,
// a network trend sparkline with a range switch, and up to five devices with
// a degraded, lossy or down status (each opens the inspector drawer).

const MAX_PROBLEM_ROWS = 5;
const SETTINGS_PATH = "/settings/scan";

function Shell({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <section
      aria-labelledby="latency-heading"
      className="bg-panel border border-line rounded-card shadow-card overflow-hidden"
    >
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-3">
        <h2 id="latency-heading" className="m-0 text-sm font-semibold text-primary">
          Latency
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="m-0 mt-0.5 text-sm font-semibold text-primary font-mono tabular-nums truncate">{value}</dd>
    </div>
  );
}

function ProblemRow({ device, onOpen }: { device: LatencyDevice; onOpen: () => void }) {
  const name = device.name || device.ip;
  const detail = device.status === "down" ? device.ip : `${formatMs(device.rtt_ms)} / ${formatPct(device.loss_pct)} loss`;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open details for ${name} (${latencyStatusLabel(device.status).toLowerCase()})`}
        className="group w-full flex items-center gap-3 text-left px-5 py-2.5 cursor-pointer hover:bg-accent-soft/60 transition-colors duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <Badge tone={latencyBadgeTone(device.status)} className="w-[76px] justify-center shrink-0">
          {latencyStatusLabel(device.status)}
        </Badge>
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="text-xs font-semibold text-primary truncate">{name}</span>
          <span className="text-[11px] text-muted font-mono truncate">{detail}</span>
        </span>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 text-muted transition-colors duration-[120ms] motion-reduce:transition-none group-hover:text-accent"
        />
      </button>
    </li>
  );
}

export function LatencyCard() {
  const summaryQuery = useLatencySummary();
  const [range, setRange] = useState<LatencyRange>("1h");
  const summary = summaryQuery.data;
  const enabled = summary?.enabled === true;
  const historyQuery = useLatencyHistory({ range });
  const { open: openInspector } = useInspector();

  if (summaryQuery.isLoading) {
    return (
      <Shell>
        <div className="flex items-center gap-2 px-5 pb-5 text-xs text-muted">
          <Spinner size={14} />
          Loading latency...
        </div>
      </Shell>
    );
  }

  if (summaryQuery.isError || !summary) {
    return (
      <Shell>
        <div className="px-5 pb-5 text-xs text-danger" role="alert">
          Latency data unavailable: {extractErrorMessage(summaryQuery.error)}
        </div>
      </Shell>
    );
  }

  if (!enabled) {
    return (
      <Shell>
        <div className="px-5 pb-5 flex flex-col gap-1.5 text-xs text-muted">
          <span>The latency monitor is disabled.</span>
          <Link to={SETTINGS_PATH} className="text-accent hover:text-accent-strong hover:underline w-fit">
            Enable it in Settings
          </Link>
        </div>
      </Shell>
    );
  }

  const net = summary.network;
  const hasData = summary.updated_at != null || net.median_ms != null || summary.devices.some((d) => d.rtt_ms != null);
  const problems = summary.devices.filter((d) => isProblemStatus(d.status)).slice(0, MAX_PROBLEM_ROWS);
  const values = (historyQuery.data?.points ?? []).map((p) => p.rtt_ms);

  return (
    <Shell
      aside={
        summary.updated_at ? (
          <span className="text-[11px] text-muted tabular-nums">updated {formatRelativeTime(summary.updated_at)}</span>
        ) : undefined
      }
    >
      {!summary.monitor_alive && (
        <div
          role="alert"
          className="mx-5 mb-3 flex items-start gap-2 px-3 py-2 rounded-control bg-warning-soft text-warning text-[11px]"
        >
          <TriangleAlert size={13} className="shrink-0 mt-px" aria-hidden="true" />
          <span>The latency-monitor service is not running. Values below may be stale.</span>
        </div>
      )}

      {!hasData ? (
        <div className="px-5 pb-5 text-xs text-muted">
          No latency data yet. The first results appear after the next monitor round.
        </div>
      ) : (
        <>
          <dl className="m-0 px-5 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-x-4 gap-y-3">
            <Stat label="Median" value={formatMs(net.median_ms)} />
            <Stat label="p95" value={formatMs(net.p95_ms)} />
            <Stat label="Loss" value={formatPct(net.loss_pct)} />
            <Stat label="Reachable" value={`${net.reachable}/${net.targets}`} />
          </dl>

          <div className="px-5 pt-4 pb-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-wider text-muted">Network median</span>
              <RangeSwitch value={range} onChange={setRange} label="Network latency range" />
            </div>
            {historyQuery.isError ? (
              <div className="text-[11px] text-muted h-10 flex items-center">History unavailable</div>
            ) : values.some((v) => v != null) ? (
              <Sparkline values={values} area height={40} ariaLabel={`Network median latency, last ${range}`} />
            ) : (
              <div className="text-[11px] text-muted h-10 flex items-center">
                {historyQuery.isLoading ? "Loading history..." : "No history for this range yet"}
              </div>
            )}
          </div>

          {problems.length > 0 ? (
            <ul className="m-0 p-0 list-none divide-y divide-line border-t border-line" aria-label="Devices with latency issues">
              {problems.map((d) => (
                <ProblemRow key={d.device_id} device={d} onOpen={() => openInspector("device", d.device_id)} />
              ))}
            </ul>
          ) : (
            <div className="px-5 py-3 border-t border-line text-[11px] text-muted">
              All monitored devices respond within their baseline.
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
