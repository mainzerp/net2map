import { useState, useEffect } from "react";
import { extractErrorMessage } from "../../../api";
import { useCreateScanJob, useScanJob, useScanRanges } from "../../../hooks/api";
import { useToast } from "../../ToastProvider";
import { Badge, Button } from "../../ui";

// ── DryRunPanel ──────────────────────────────────────────────────────────────
interface DryRunPreviewItem {
  ip: string;
  sys_name?: string;
  already_exists?: boolean;
  no_profile_suitable?: boolean;
  vendor?: string;
}

interface DryRunResult {
  status?: string;
  scanned?: number;
  found?: number;
  errors?: string[];
  total_duration_ms?: number;
  preview: DryRunPreviewItem[];
}

// Starts a discovery dry-run job and polls it until done. The polling is
// bounded so a stuck job cannot leak polling forever.
const DRY_RUN_POLL = { intervalMs: 2000, maxErrors: 5, maxDurationMs: 5 * 60_000 };

function DryRunPanel() {
  const { data: scanRanges = [], isLoading: rangesLoading } = useScanRanges();
  // The dry run probes every enabled range; disabled ranges are skipped.
  const enabledRangeCount = scanRanges.filter((r) => r.enabled).length;
  const [dryRunLoading, setDryRunLoading] = useState<boolean>(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const { addToast } = useToast();
  const createJob = useCreateScanJob();
  const { job, finished, error: pollError, timedOut } = useScanJob<Partial<DryRunResult>>(jobId, DRY_RUN_POLL);

  useEffect(() => {
    if (!job?.result) return;
    const preview: DryRunPreviewItem[] = job.result?.preview ?? [];
    setDryRunResult({
      status: job.result.status,
      scanned: job.result.scanned,
      found: job.result.found,
      errors: job.result.errors,
      total_duration_ms: job.result.total_duration_ms,
      preview,
    });
  }, [job]);

  useEffect(() => {
    if (!finished) return;
    setJobId(null);
    setDryRunLoading(false);
  }, [finished]);

  useEffect(() => {
    if (!pollError && !timedOut) return;
    const message = timedOut ? "Timed out waiting for the dry run result (5 min)" : extractErrorMessage(pollError);
    setJobId(null);
    setDryRunResult({ status: "error", errors: [message], preview: [] });
    setDryRunLoading(false);
    addToast(`Dry run failed: ${message}`, "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollError, timedOut]);

  const runDryRun = async () => {
    setDryRunLoading(true);
    setDryRunResult(null);
    setJobId(null);
    try {
      setJobId(await createJob.mutateAsync({ dryRun: true }));
    } catch (ex) {
      setDryRunResult({ status: "error", errors: [extractErrorMessage(ex)], preview: [] });
      setDryRunLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          onClick={runDryRun}
          disabled={rangesLoading || dryRunLoading || enabledRangeCount === 0}
        >
          {dryRunLoading ? "Scanning..." : "Dry Run"}
        </Button>
        {!rangesLoading && (
          <span className="text-muted text-[10px] opacity-70">
            {enabledRangeCount === 0
              ? scanRanges.length === 0
                ? "Configure ranges above to enable a dry run"
                : "Enable at least one range above to run a dry run"
              : `Probes ${enabledRangeCount} enabled range(s) without creating credentials`}
          </span>
        )}
      </div>
      {dryRunResult && (
        <div className="mt-1 p-3 rounded-card bg-panel-2 border border-line-strong">
          <div className="text-muted text-[10px] font-bold tracking-[1px] mb-2 select-none">
            DRY RUN RESULT - {dryRunResult.found ?? 0} host(s) found, {dryRunResult.scanned ?? 0} probed
            {dryRunResult.total_duration_ms != null ? ` - ${(dryRunResult.total_duration_ms / 1000).toFixed(1)}s` : ""}
          </div>
          {(dryRunResult.preview || []).length === 0 ? (
            <div className="text-muted text-[11px]">No responding hosts found in the enabled ranges.</div>
          ) : (
            <div className="flex flex-col gap-1">
              {(dryRunResult.preview || []).map((item, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-2 flex-wrap px-2 py-1 rounded border ${
                    item.no_profile_suitable
                      ? "border-danger"
                      : item.already_exists
                        ? "border-success"
                        : "border-line-strong"
                  }`}
                >
                  <span className="text-accent font-mono text-[11px] min-w-[120px]">{item.ip}</span>
                  <span className="text-muted text-[11px]">{item.sys_name || "-"}</span>
                  {item.already_exists && <Badge tone="success">existing</Badge>}
                  {item.no_profile_suitable && <Badge tone="danger">no profile suitable</Badge>}
                  {!item.no_profile_suitable && !item.already_exists && (
                    <Badge tone="accent">would create credential</Badge>
                  )}
                  {item.vendor && item.vendor !== "unknown" && (
                    <span className="text-muted text-[10px]">{item.vendor}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {(dryRunResult.errors || []).length > 0 && (
            <div className="mt-2 text-danger text-[10px]">
              {dryRunResult.errors!.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default DryRunPanel;
