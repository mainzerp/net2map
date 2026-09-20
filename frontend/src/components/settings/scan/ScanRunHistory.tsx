import { useState, useEffect, useRef } from "react";
import { api, extractErrorMessage } from "../../../api";
import { queryKeys, useInvalidateApi, useScanRuns } from "../../../hooks/api";
import { Button, Card, EmptyState } from "../../ui";
import { SectionHeader, TabLoading } from "../shared";
import { fmtDuration, fmtTs } from "./format";

// ── ScanRunHistory ───────────────────────────────────────────────────────────
interface ScanResult {
  scanned?: number;
  found?: number;
  links?: number;
  errors?: string[];
  status?: string;
  total_duration_ms?: number;
  max_workers?: number;
  switch_metrics?: SwitchMetric[];
}

interface SwitchMetric {
  ip: string;
  label?: string;
  duration_ms: number;
  success: boolean;
}

// Run-scan action with job polling, the latest result panel, and the
// persisted scan run history.
function ScanRunHistory() {
  const { data: history = [], isLoading: historyLoading } = useScanRuns(20);
  const { invalidate } = useInvalidateApi();
  const [scanning, setScanning] = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopPolling, []);

  const startPolling = (jobId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const st = await api.get(`/api/scan/jobs/${jobId}`);
        if (st?.result) {
          setScanResult(st.result);
        }
        if (st?.status && st.status !== "running") {
          setScanning(false);
          setActiveJobId(null);
          stopPolling();
          invalidate(queryKeys.scanRuns, queryKeys.topology, queryKeys.devices, queryKeys.stats);
        }
      } catch (_) {
        // keep polling on transient UI/API glitches
      }
    }, 1500);
  };

  const runScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const job: { job_id?: string } = await api.post("/api/scan/jobs", {});
      if (!job?.job_id) throw new Error("Scan job could not be created");
      setActiveJobId(job.job_id);
      startPolling(job.job_id);
    } catch (e) {
      setScanning(false);
      setScanResult({ scanned: 0, found: 0, links: 0, errors: [extractErrorMessage(e)], status: "failed" });
    }
  };

  const cancelScan = async () => {
    if (!activeJobId) return;
    await api.post(`/api/scan/jobs/${activeJobId}/cancel`, {});
  };

  const statBlock = (label: string, value: number | string, colorClass: string) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted text-[9px] tracking-[1px]">{label}</span>
      <span className={`text-base font-bold ${colorClass}`}>{value}</span>
    </div>
  );

  return (
    <>
      <Card title={<SectionHeader>NETWORK SCAN</SectionHeader>}>
        <div className="text-muted text-[11px] leading-relaxed mb-3">
          Discovers switches, ports, and LLDP neighbor links from enabled SNMP credentials.
        </div>
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={runScan} disabled={scanning} className="px-6 py-2.5">
            {scanning ? "Scanning..." : "Run Scan"}
          </Button>
          {scanning && activeJobId && (
            <Button variant="danger" onClick={cancelScan}>Cancel</Button>
          )}
          {scanning && (
            <span className="text-muted text-[10px]">
              Job {activeJobId ? activeJobId.slice(0, 8) : "-"} is running...
            </span>
          )}
        </div>
      </Card>

      {/* Latest result */}
      {scanResult && !scanning && (
        <Card className={scanResult.errors?.length ? "border-danger" : "border-success"}>
          <div className={`text-[11px] font-semibold mb-2 ${scanResult.errors?.length ? "text-danger" : "text-success"}`}>
            {scanResult.errors?.length ? "Scan completed with errors" : "Scan completed successfully"}
          </div>
          <div className="flex gap-5 flex-wrap">
            {statBlock("SCANNED", scanResult.scanned ?? 0, "text-primary")}
            {statBlock("FOUND", scanResult.found ?? 0, "text-accent")}
            {statBlock("LINKS", scanResult.links ?? 0, "text-accent")}
            {statBlock("TOTAL TIME", fmtDuration(scanResult.total_duration_ms), "text-accent")}
            {statBlock("WORKERS", scanResult.max_workers ?? 1, "text-muted")}
          </div>
          {(scanResult.switch_metrics?.length ?? 0) > 0 && (
            <div className="mt-2.5 border-t border-line pt-2">
              <div className="text-muted text-[9px] tracking-[1px] mb-1.5">SWITCH DURATIONS</div>
              <div className="flex flex-col gap-1 max-h-[180px] overflow-y-auto">
                {scanResult.switch_metrics!.map((m, i) => (
                  <div
                    key={`${m.ip}-${i}`}
                    className={`grid grid-cols-[1fr_90px_60px] gap-2 text-[10px] py-1 ${
                      i < scanResult.switch_metrics!.length - 1 ? "border-b border-line" : ""
                    }`}
                  >
                    <span className={`truncate ${m.success ? "text-muted" : "text-danger"}`}>
                      {(m.label ? `${m.label} ` : "") + `(${m.ip})`}
                    </span>
                    <span className="text-accent text-right">{fmtDuration(m.duration_ms)}</span>
                    <span className={`text-right ${m.success ? "text-success" : "text-danger"}`}>
                      {m.success ? "OK" : "FAIL"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(scanResult.errors?.length ?? 0) > 0 && (
            <div className="mt-2.5 border-t border-danger pt-2">
              <div className="text-danger text-[9px] tracking-[1px] mb-1">ERRORS</div>
              {scanResult.errors!.map((e, i) => (
                <div key={i} className="text-danger text-[10px] py-0.5">{e}</div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Persisted history */}
      <Card title={<SectionHeader>SCAN HISTORY (persisted)</SectionHeader>}>
        {historyLoading ? (
          <TabLoading />
        ) : history.length === 0 ? (
          <EmptyState title="No scan runs yet" className="py-4" />
        ) : (
          history.map((h) => (
            <div key={h.id} className="flex flex-col gap-1 py-1.5 border-b border-line text-[10px] last:border-b-0">
              <div className="flex items-center gap-3">
                <span className="text-muted min-w-[70px]">{fmtTs(h.created_at)}</span>
                <span
                  className={`min-w-[22px] font-semibold ${
                    h.status === "finished" ? "text-success" : h.status === "cancelled" ? "text-warning" : "text-danger"
                  }`}
                >
                  {h.status === "finished" ? "OK" : h.status === "cancelled" ? "CAN" : "ERR"}
                </span>
                <span className="text-muted">
                  {h.found} switches, {h.links} links
                  <span className="opacity-80"> - {fmtDuration(h.total_duration_ms)}</span>
                  <span className="opacity-70"> - w:{h.max_workers}</span>
                  {(h.error_count ?? 0) > 0 && <span className="text-danger"> ({h.error_count} errors)</span>}
                </span>
              </div>
              <div className="flex gap-2.5 flex-wrap pl-[82px] text-muted">
                <span className={(h.new_devices?.length || 0) > 0 ? "text-success" : ""}>+dev {h.new_devices?.length || 0}</span>
                <span className={(h.removed_devices?.length || 0) > 0 ? "text-danger" : ""}>-dev {h.removed_devices?.length || 0}</span>
                <span className={(h.new_links?.length || 0) > 0 ? "text-accent" : ""}>+link {h.new_links?.length || 0}</span>
                <span className={(h.removed_links?.length || 0) > 0 ? "text-warning" : ""}>-link {h.removed_links?.length || 0}</span>
              </div>
              {((h.new_devices?.length || 0) > 0 || (h.removed_devices?.length || 0) > 0) && (
                <div className="pl-[82px] text-muted flex flex-col gap-0.5">
                  {(h.new_devices?.length ?? 0) > 0 && <div>new devices: {h.new_devices!.join(", ")}</div>}
                  {(h.removed_devices?.length ?? 0) > 0 && <div>removed devices: {h.removed_devices!.join(", ")}</div>}
                </div>
              )}
              {((h.new_links?.length || 0) > 0 || (h.removed_links?.length || 0) > 0) && (
                <div className="pl-[82px] text-muted flex flex-col gap-0.5">
                  {(h.new_links?.length ?? 0) > 0 && (
                    <div>new links: {h.new_links!.slice(0, 3).join(" | ")}{h.new_links!.length > 3 ? " ..." : ""}</div>
                  )}
                  {(h.removed_links?.length ?? 0) > 0 && (
                    <div>removed links: {h.removed_links!.slice(0, 3).join(" | ")}{h.removed_links!.length > 3 ? " ..." : ""}</div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </Card>
    </>
  );
}

export default ScanRunHistory;
