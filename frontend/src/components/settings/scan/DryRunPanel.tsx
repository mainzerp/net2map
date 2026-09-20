import { useState, useEffect, useRef } from "react";
import { api, extractErrorMessage } from "../../../api";
import { useDiscoveryRanges } from "../../../hooks/api";
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
function DryRunPanel() {
  const { data: discoveryRanges = [], isLoading: rangesLoading } = useDiscoveryRanges();
  const [dryRunLoading, setDryRunLoading] = useState<boolean>(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const dryRunPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { addToast } = useToast();

  const stopDryRunPolling = () => {
    if (dryRunPollRef.current) {
      clearInterval(dryRunPollRef.current);
      dryRunPollRef.current = null;
    }
  };

  useEffect(() => stopDryRunPolling, []);

  const runDryRun = async () => {
    setDryRunLoading(true);
    setDryRunResult(null);
    stopDryRunPolling();
    try {
      const job: { job_id?: string } = await api.post("/api/scan/dry-run/jobs", {});
      if (!job?.job_id) throw new Error("Dry run job could not be created");
      const MAX_ATTEMPTS = 150; // 150 x 2s = 5 minutes
      const MAX_ERRORS = 5;
      let attempts = 0;
      let consecutiveErrors = 0;
      const failDryRun = (message: string) => {
        stopDryRunPolling();
        setDryRunResult({ status: "error", errors: [message], preview: [] });
        setDryRunLoading(false);
        addToast(`Dry run failed: ${message}`, "error");
      };
      dryRunPollRef.current = setInterval(async () => {
        attempts += 1;
        if (attempts > MAX_ATTEMPTS) {
          failDryRun("Timed out waiting for the dry run result (5 min)");
          return;
        }
        try {
          const st = await api.get(`/api/scan/jobs/${job.job_id}`);
          consecutiveErrors = 0;
          if (st?.result) {
            const preview: DryRunPreviewItem[] = st.result?.preview ?? [];
            setDryRunResult({
              status: st.result.status,
              scanned: st.result.scanned,
              found: st.result.found,
              errors: st.result.errors,
              total_duration_ms: st.result.total_duration_ms,
              preview,
            });
          }
          if (st?.status && st.status !== "running") {
            stopDryRunPolling();
            setDryRunLoading(false);
          }
        } catch (ex) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_ERRORS) {
            failDryRun(extractErrorMessage(ex));
          }
        }
      }, 2000);
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
          disabled={rangesLoading || dryRunLoading || discoveryRanges.length === 0}
        >
          {dryRunLoading ? "Scanning..." : "Dry Run"}
        </Button>
        {discoveryRanges.length === 0 && !rangesLoading && (
          <span className="text-muted text-[10px] opacity-70">Configure ranges above to enable a dry run</span>
        )}
      </div>
      {dryRunResult && (
        <div className="mt-1 p-3 rounded-lg bg-panel-2 border border-line-strong">
          <div className="text-muted text-[10px] font-bold tracking-[1px] mb-2 select-none">
            DRY RUN RESULT - {dryRunResult.found ?? 0} host(s) found, {dryRunResult.scanned ?? 0} probed
            {dryRunResult.total_duration_ms != null ? ` - ${(dryRunResult.total_duration_ms / 1000).toFixed(1)}s` : ""}
          </div>
          {(dryRunResult.preview || []).length === 0 ? (
            <div className="text-muted text-[11px]">No responding hosts found in configured ranges.</div>
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
