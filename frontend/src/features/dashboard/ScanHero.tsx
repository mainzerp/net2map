import { CircleCheck, CircleX, Clock, Play, Radar, Square } from "lucide-react";
import { Badge, Button, Spinner } from "../../components/ui";
import { formatTimestamp } from "../../utils/datetime";
import type { ScanProgress, ScanRun } from "../../types";

// Compact scan bar shown under the dashboard header: current scan status,
// progress, and the single primary action (start scan) or cancel while running.
// The component keeps its historical name (ScanHero) for import stability.

interface ScanHeroProps {
  scanning: boolean;
  progress: ScanProgress | null;
  scanError: string | null;
  lastRun: ScanRun | null;
  onStartScan: () => void;
  // Optional: requests cancellation of the active scan job.
  onCancelScan?: () => void;
  cancelling?: boolean;
}

function LastRunBadge({ status }: { status: string }) {
  if (status === "completed" || status === "finished") {
    return (
      <Badge tone="success">
        <CircleCheck size={11} aria-hidden="true" />
        {status}
      </Badge>
    );
  }
  if (status === "failed" || status === "error") {
    return (
      <Badge tone="danger">
        <CircleX size={11} aria-hidden="true" />
        {status}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <Clock size={11} aria-hidden="true" />
      {status}
    </Badge>
  );
}

export function ScanHero({
  scanning,
  progress,
  scanError,
  lastRun,
  onStartScan,
  onCancelScan,
  cancelling = false,
}: ScanHeroProps) {
  const showProgress = scanning && progress?.type === "scan_progress";
  const total = progress?.total ?? 0;
  const scanned = progress?.scanned ?? 0;
  const pct = total > 0 ? Math.round((scanned / total) * 100) : 0;

  return (
    <div
      className="flex flex-col gap-2 rounded-card border border-line bg-panel shadow-card px-4 py-3"
      aria-label="Network scan"
      role="region"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <Radar
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className={`shrink-0 ${scanning ? "text-accent" : "text-muted"}`}
        />
        <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap text-xs">
          {showProgress ? (
            <>
              <span className="font-semibold text-primary tabular-nums">
                Scanning {scanned} of {total || "?"}
              </span>
              <span className="text-muted tabular-nums">{pct}%</span>
              {progress?.latest_ip && (
                <span className="text-muted font-mono truncate">{progress.latest_ip}</span>
              )}
            </>
          ) : scanning ? (
            <span className="inline-flex items-center gap-2 text-muted">
              <Spinner size={12} />
              Starting scan...
            </span>
          ) : lastRun ? (
            <>
              <span className="text-muted">
                Last scan <span className="text-primary tabular-nums">{formatTimestamp(lastRun.created_at)}</span>
              </span>
              <LastRunBadge status={lastRun.status} />
            </>
          ) : (
            <span className="text-muted">No scan has run yet. Start a scan to discover your network.</span>
          )}
        </div>
        {scanning ? (
          onCancelScan && (
            <Button variant="secondary" size="sm" onClick={onCancelScan} disabled={cancelling}>
              <Square size={12} aria-hidden="true" />
              {cancelling ? "Cancelling..." : "Cancel"}
            </Button>
          )
        ) : (
          <Button variant="primary" size="sm" onClick={onStartScan}>
            <Play size={12} aria-hidden="true" />
            Start scan
          </Button>
        )}
      </div>

      {showProgress && (
        <div
          className="h-1 rounded-full bg-panel-2 overflow-hidden"
          role="progressbar"
          aria-label="Scan progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
      {scanError && (
        <div className="flex items-center gap-1.5 text-xs text-danger">
          <CircleX size={12} aria-hidden="true" />
          Scan failed: {scanError}
        </div>
      )}
    </div>
  );
}
