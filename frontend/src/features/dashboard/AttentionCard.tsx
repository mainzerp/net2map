import { useNavigate } from "react-router-dom";
import { ArrowRight, ChevronRight, CircleCheck, CircleX, EyeOff, TriangleAlert, type LucideIcon } from "lucide-react";
import { formatRelativeTime, formatTimestamp } from "../../utils/datetime";
import { healthOf, healthSummary, needsAttention } from "../../utils/deviceHealth";
import { useInspector } from "../../hooks/useInspector";
import type { ScanRun, TopologyNode } from "../../types";

// Primary dashboard block: everything that needs a human look, as rows with an
// icon+word status chip on a soft background (status never by color alone).

type IssueTone = "danger" | "warning" | "neutral";

const CHIP_CLASS: Record<IssueTone, string> = {
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-panel-2 text-muted",
};

function StatusChip({ tone, icon: Icon, label }: { tone: IssueTone; icon: LucideIcon; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 shrink-0 w-[76px] justify-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${CHIP_CLASS[tone]}`}
    >
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}

function IssueRow({
  tone,
  icon,
  chip,
  title,
  detail,
  meta,
  onClick,
  opensInspector = false,
  ariaLabel,
}: {
  tone: IssueTone;
  icon: LucideIcon;
  chip: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  meta?: React.ReactNode;
  onClick: () => void;
  // Device rows open the inspector drawer: always-visible chevron and the
  // same accent hover tint as clickable table rows.
  opensInspector?: boolean;
  ariaLabel?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className={`group w-full flex items-center gap-3 text-left px-5 py-3 cursor-pointer transition-colors duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
          opensInspector ? "hover:bg-accent-soft/60 focus-visible:bg-accent-soft/60" : "hover:bg-panel-2/60"
        }`}
      >
        <StatusChip tone={tone} icon={icon} label={chip} />
        <span className="flex-1 min-w-0 flex items-baseline gap-2">
          <span className="text-xs font-semibold text-primary truncate">{title}</span>
          {detail != null && <span className="text-[11px] text-muted font-mono truncate">{detail}</span>}
        </span>
        {meta != null && <span className="hidden sm:inline text-[11px] text-muted whitespace-nowrap tabular-nums">{meta}</span>}
        {opensInspector ? (
          <ChevronRight
            size={14}
            aria-hidden="true"
            data-testid="attention-open-chevron"
            className="shrink-0 text-muted transition-colors duration-[120ms] motion-reduce:transition-none group-hover:text-accent group-focus-visible:text-accent"
          />
        ) : (
          <ArrowRight
            size={14}
            aria-hidden="true"
            className="shrink-0 text-muted opacity-0 group-hover:opacity-100 transition-opacity"
          />
        )}
      </button>
    </li>
  );
}

export interface AttentionCardProps {
  nodes: TopologyNode[];
  lastRun?: ScanRun | null;
  className?: string;
}

export function AttentionCard({ nodes, lastRun = null, className = "" }: AttentionCardProps) {
  const navigate = useNavigate();
  const { open: openInspector } = useInspector();
  const offline = nodes.filter((n) => !n.ignored && n.ping_status === "offline");
  // UPS / server health warnings; offline devices are already listed above.
  const unhealthy = nodes
    .filter((n) => !n.ignored && n.ping_status !== "offline" && needsAttention(n))
    .sort((a, b) => Number(healthOf(b)?.status === "critical") - Number(healthOf(a)?.status === "critical"));
  const ignoredCount = nodes.filter((n) => n.ignored).length;
  const unassignedCount = nodes.filter((n) => !n.ignored && !n.rack_id).length;
  const lastScanFailed = lastRun != null && (lastRun.status === "failed" || lastRun.status === "error");

  const issueCount =
    offline.length + unhealthy.length + (lastScanFailed ? 1 : 0) + (unassignedCount > 0 ? 1 : 0);
  const hasRows = issueCount > 0 || ignoredCount > 0;

  return (
    <section
      aria-labelledby="attention-heading"
      className={`bg-panel border border-line rounded-card shadow-card overflow-hidden ${className}`}
    >
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-3">
        <h2 id="attention-heading" className="m-0 text-sm font-semibold text-primary">
          Attention needed
        </h2>
        <span className="text-[11px] text-muted tabular-nums">
          {issueCount === 0 ? "Nothing open" : `${issueCount} open item${issueCount === 1 ? "" : "s"}`}
        </span>
      </div>

      {!hasRows ? (
        <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center border-t border-line">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-success-soft text-success">
            <CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="text-sm font-semibold text-primary">All devices reachable</div>
          <div className="text-[11px] text-muted max-w-xs">
            No offline switches, no failed scans and every switch is placed in a rack. Nothing needs your attention.
          </div>
        </div>
      ) : (
        <ul className="m-0 p-0 list-none divide-y divide-line border-t border-line">
          {lastScanFailed && lastRun && (
            <IssueRow
              tone="danger"
              icon={CircleX}
              chip="Failed"
              title="Last scan failed"
              meta={formatTimestamp(lastRun.created_at)}
              onClick={() => navigate("/settings/scan")}
            />
          )}
          {offline.map((d) => (
            <IssueRow
              key={d.id}
              tone="danger"
              icon={CircleX}
              chip="Offline"
              title={d.sys_name || d.hostname || d.ip}
              detail={d.ip}
              meta={`last seen ${formatTimestamp(d.last_seen as string | null)}`}
              opensInspector
              ariaLabel={`Open details for ${d.sys_name || d.hostname || d.ip} (offline)`}
              onClick={() => openInspector("device", d.id)}
            />
          ))}
          {unhealthy.map((d) => {
            const health = healthOf(d);
            if (!health) return null;
            const critical = health.status === "critical";
            const name = d.sys_name || d.hostname || d.ip;
            return (
              <IssueRow
                key={`health-${d.id}`}
                tone={critical ? "danger" : "warning"}
                icon={critical ? CircleX : TriangleAlert}
                chip={critical ? "Critical" : "Warning"}
                title={name}
                detail={healthSummary(health)}
                meta={d.health_updated_at ? `updated ${formatRelativeTime(d.health_updated_at)}` : undefined}
                opensInspector
                ariaLabel={`Open details for ${name} (health ${health.status})`}
                onClick={() => openInspector("device", d.id)}
              />
            );
          })}
          {unassignedCount > 0 && (
            <IssueRow
              tone="warning"
              icon={TriangleAlert}
              chip="No rack"
              title={`${unassignedCount} switch${unassignedCount === 1 ? "" : "es"} not assigned to a rack`}
              onClick={() => navigate("/network")}
            />
          )}
          {ignoredCount > 0 && (
            <IssueRow
              tone="neutral"
              icon={EyeOff}
              chip="Ignored"
              title={`${ignoredCount} ignored device${ignoredCount === 1 ? "" : "s"} excluded from scans`}
              onClick={() => navigate("/network")}
            />
          )}
        </ul>
      )}
    </section>
  );
}
