import { Badge, Button, Card, Spinner } from "../../components/ui";
import { formatTimestamp } from "../../utils/datetime";
import type { ScanProgress, ScanRun } from "../../types";

interface ScanHeroProps {
  scanning: boolean;
  progress: ScanProgress | null;
  scanError: string | null;
  lastRun: ScanRun | null;
  onStartScan: () => void;
}

function statusTone(status: string): "success" | "danger" | "neutral" {
  if (status === "completed" || status === "finished") return "success";
  if (status === "failed" || status === "error") return "danger";
  return "neutral";
}

export function ScanHero({ scanning, progress, scanError, lastRun, onStartScan }: ScanHeroProps) {
  const showProgress = scanning && progress?.type === "scan_progress";
  const total = progress?.total ?? 0;
  const scanned = progress?.scanned ?? 0;
  const pct = total > 0 ? Math.round((scanned / total) * 100) : 0;

  return (
    <Card
      title="Network scan"
      actions={
        <Button variant="primary" size="sm" onClick={onStartScan} disabled={scanning}>
          {scanning ? "Scanning..." : "Run Scan"}
        </Button>
      }
    >
      {showProgress ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-accent">
              Scanning: {scanned} / {total || "?"}
            </span>
            <span className="text-muted font-mono">{progress?.latest_ip ?? ""}</span>
          </div>
          <div className="h-1.5 rounded bg-panel-2 overflow-hidden">
            <div
              className="h-full rounded bg-accent transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : scanning ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} />
          Starting scan...
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted">
          {lastRun ? (
            <>
              <span>Last scan: {formatTimestamp(lastRun.finished_at ?? lastRun.started_at)}</span>
              <Badge tone={statusTone(lastRun.status)}>{lastRun.status}</Badge>
            </>
          ) : (
            <span>No scan has run yet. Start a scan to discover your network.</span>
          )}
        </div>
      )}
      {scanError && <div className="mt-2 text-xs text-danger">Scan failed: {scanError}</div>}
    </Card>
  );
}
