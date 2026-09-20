import { useState, useEffect, useRef } from "react";
import { api, extractErrorMessage } from "../../api";
import { useToast } from "../ToastProvider";

// ── Local interfaces ────────────────────────────────────────────────────────
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

interface ScanHistoryEntry {
  id: string;
  status: string;
  created_at?: string;
  found?: number;
  links?: number;
  total_duration_ms?: number;
  max_workers?: number;
  error_count?: number;
  new_devices?: string[];
  removed_devices?: string[];
  new_links?: string[];
  removed_links?: string[];
  [key: string]: unknown;
}

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

interface AppSetting {
  key: string;
  value?: string | null;
  [key: string]: unknown;
}

// ── EngineTabContent ────────────────────────────────────────────────────────
function EngineTabContent() {
  const [scanning, setScanning]     = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [history, setHistory]       = useState<ScanHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(true);
  const [scanWorkers, setScanWorkers] = useState<number | string>(4);
  const [snmpTimeout, setSnmpTimeout] = useState<number | string>(3);
  const [snmpRetries, setSnmpRetries] = useState<number | string>(1);
  const [discoveryIntervalSec, setDiscoveryIntervalSec] = useState<number | string>(1800);
  const [linkUpdateIntervalSec, setLinkUpdateIntervalSec] = useState<number | string>(30);
  const [macUpdateIntervalSec, setMacUpdateIntervalSec] = useState<number | string>(30);
  const [settingsLoading, setSettingsLoading] = useState<boolean>(true);
  const [settingsSaving, setSettingsSaving] = useState<boolean>(false);
  const [settingsError, setSettingsError] = useState<string>("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  // Discovery ranges state
  const [discoveryRanges, setDiscoveryRanges] = useState<string[]>([]);
  const [rangesInput, setRangesInput] = useState<string>("");
  const [rangesSaving, setRangesSaving] = useState<boolean>(false);
  const [rangesError, setRangesError] = useState<string>("");

  // Dry run state
  const [dryRunLoading, setDryRunLoading] = useState<boolean>(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dryRunPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { addToast } = useToast();

  useEffect(() => {
    Promise.allSettled([api.get("/api/scan-settings"), api.get("/api/settings"), api.get("/api/discovery-ranges")])
      .then(([scanSettingsRes, appSettingsRes, rangesRes]) => {
        const scanSettings = scanSettingsRes.status === "fulfilled" ? scanSettingsRes.value : null;
        const appSettings = appSettingsRes.status === "fulfilled" ? appSettingsRes.value : null;
        const rangesResp = rangesRes.status === "fulfilled" ? rangesRes.value : null;
        if (scanSettings?.max_workers != null) setScanWorkers(Number(scanSettings.max_workers));
        if (scanSettings?.snmp_timeout != null) setSnmpTimeout(Number(scanSettings.snmp_timeout));
        if (scanSettings?.snmp_retries != null) setSnmpRetries(Number(scanSettings.snmp_retries));

        const settingsList: AppSetting[] = Array.isArray(appSettings) ? appSettings : [];
        const discovery = settingsList.find(s => s.key === "discovery_interval_sec");
        const legacyPorts = settingsList.find(s => s.key === "port_update_interval_sec");
        const links = settingsList.find(s => s.key === "link_update_interval_sec");
        const macs = settingsList.find(s => s.key === "mac_update_interval_sec");
        const fallbackPortValue = legacyPorts?.value != null ? Number(legacyPorts.value) : 30;
        if (discovery?.value != null) setDiscoveryIntervalSec(Number(discovery.value));
        setLinkUpdateIntervalSec(links?.value != null ? Number(links.value) : fallbackPortValue);
        setMacUpdateIntervalSec(macs?.value != null ? Number(macs.value) : fallbackPortValue);

        const ranges: string[] = Array.isArray(rangesResp?.ranges) ? rangesResp.ranges : [];
        setDiscoveryRanges(ranges);
        setRangesInput(ranges.join("\n"));
      })
      .finally(() => setSettingsLoading(false));
  }, []);

  const loadHistory = () => {
    setHistoryLoading(true);
    api.get("/api/scan-runs?limit=20")
      .then((runs: ScanHistoryEntry[]) => setHistory(Array.isArray(runs) ? runs : []))
      .finally(() => setHistoryLoading(false));
  };

  useEffect(() => {
    loadHistory();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (dryRunPollRef.current) clearInterval(dryRunPollRef.current);
    };
  }, []);

  const saveScanSettings = async () => {
    setSettingsSaving(true);
    setSettingsError("");
    try {
      const payload = { 
        max_workers: Math.max(1, Math.min(128, Number(scanWorkers) || 1)),
        snmp_timeout: Math.max(1, Math.min(30, Number(snmpTimeout) || 3)),
        snmp_retries: Math.max(0, Math.min(10, Number(snmpRetries) || 1))
      };

      const nextDiscoveryInterval = Math.max(0, Math.min(86400, Number(discoveryIntervalSec) || 0));
      const nextLinksInterval = Math.max(0, Math.min(3600, Number(linkUpdateIntervalSec) || 0));
      const nextMacsInterval = Math.max(0, Math.min(3600, Number(macUpdateIntervalSec) || 0));

      const result = await api.put("/api/scan-settings", payload);
      await api.put("/api/settings/discovery_interval_sec", { value: String(nextDiscoveryInterval) });
      await api.put("/api/settings/link_update_interval_sec", { value: String(nextLinksInterval) });
      await api.put("/api/settings/mac_update_interval_sec", { value: String(nextMacsInterval) });
      // Intentional migration sync: the backend still reads the legacy
      // port_update_interval_sec key as a fallback, so keep it in step.
      await api.put("/api/settings/port_update_interval_sec", { value: String(nextMacsInterval) });

      if (result?.max_workers != null) setScanWorkers(Number(result.max_workers));
      if (result?.snmp_timeout != null) setSnmpTimeout(Number(result.snmp_timeout));
      if (result?.snmp_retries != null) setSnmpRetries(Number(result.snmp_retries));
      setDiscoveryIntervalSec(nextDiscoveryInterval);
      setLinkUpdateIntervalSec(nextLinksInterval);
      setMacUpdateIntervalSec(nextMacsInterval);
    } catch (err) {
      setSettingsError(extractErrorMessage(err));
    } finally {
      setSettingsSaving(false);
    }
  };

  const saveDiscoveryRanges = async () => {
    setRangesError("");
    setRangesSaving(true);
    try {
      const lines = rangesInput
        .split(/[\n,;]+/)
        .map(s => s.trim())
        .filter(Boolean);
      const resp = await api.put("/api/discovery-ranges", { ranges: lines });
      const saved: string[] = Array.isArray(resp?.ranges) ? resp.ranges : lines;
      setDiscoveryRanges(saved);
      setRangesInput(saved.join("\n"));
    } catch (ex) {
      setRangesError(extractErrorMessage(ex));
    } finally {
      setRangesSaving(false);
    }
  };

  const removeRange = (idx: number) => {
    const next = discoveryRanges.filter((_, i) => i !== idx);
    setDiscoveryRanges(next);
    setRangesInput(next.join("\n"));
  };

  const runDryRun = async () => {
    setDryRunLoading(true);
    setDryRunResult(null);
    if (dryRunPollRef.current) { clearInterval(dryRunPollRef.current); dryRunPollRef.current = null; }
    try {
      const job: { job_id?: string } = await api.post("/api/scan/dry-run/jobs", {});
      if (!job?.job_id) throw new Error("Dry run job could not be created");
      // Poll until done; bounded so a stuck job cannot leak polling forever.
      const MAX_ATTEMPTS = 150; // 150 x 2s = 5 minutes
      const MAX_ERRORS = 5;
      let attempts = 0;
      let consecutiveErrors = 0;
      const stopDryRunPolling = () => {
        if (dryRunPollRef.current) { clearInterval(dryRunPollRef.current); dryRunPollRef.current = null; }
      };
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

  const fmtDuration = (ms: number | undefined | null): string => {
    const value = Number(ms || 0);
    if (value < 1000) return `${value} ms`;
    return `${(value / 1000).toFixed(2)} s`;
  };

  const discoverySeconds = Math.max(0, Number(discoveryIntervalSec) || 0);
  const linkSeconds = Math.max(0, Number(linkUpdateIntervalSec) || 0);
  const macSeconds = Math.max(0, Number(macUpdateIntervalSec) || 0);
  const discoveryLabel = discoverySeconds === 0
    ? "disabled"
    : discoverySeconds >= 60
      ? `${(discoverySeconds / 60).toFixed(discoverySeconds % 60 === 0 ? 0 : 1)} min`
      : `${discoverySeconds}s`;
  const linksLabel = linkSeconds === 0 ? "disabled" : `${linkSeconds}s`;
  const macsLabel = macSeconds === 0 ? "disabled" : `${macSeconds}s`;

  const fmtTs = (ts: string | undefined | null): string => {
    if (!ts) return "-";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString();
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

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
          loadHistory();
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

  const btnStyle: React.CSSProperties = {
    border: "1px solid #164e63", background: "#083344", color: "#22d3ee",
    borderRadius: 6, padding: "10px 24px", cursor: "pointer",
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, fontWeight: 600,
    transition: "all 0.15s",
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", paddingTop: 20, display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Scan action */}
      <div style={{
        backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 10,
        padding: 20, display: "flex", flexDirection: "column", gap: 14,
      }}>
        <div style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: 2 }}>NETWORK SCAN</div>
        <div style={{ color: "#475569", fontSize: 11, lineHeight: 1.6 }}>
          Discovers switches, ports, and LLDP neighbor links from enabled SNMP credentials.
        </div>
        <div style={{
          display:"flex", flexDirection:"column", gap:6,
          padding:"10px 12px", border:"1px solid #1e293b", borderRadius:8, backgroundColor:"#020817",
        }}>
          <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1.2 }}>GENERAL ENGINE SETTINGS</div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ color:"#64748b", fontSize:10 }}>Parallel Workers (Hosts)</span>
            <input
              type="number"
              min={1}
              max={128}
              value={scanWorkers}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setScanWorkers(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:60, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#64748b", fontSize:10, marginLeft:8 }}>Timeout (s)</span>
            <input
              type="number"
              min={1}
              max={30}
              value={snmpTimeout}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSnmpTimeout(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:60, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#64748b", fontSize:10, marginLeft:8 }}>Retries</span>
            <input
              type="number"
              min={0}
              max={10}
              value={snmpRetries}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSnmpRetries(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:60, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#334155", fontSize:10 }}>
              {settingsLoading ? "Loading settings..." : "1-128 workers"}
            </span>
          </div>
        </div>
        <div style={{
          display:"flex", flexDirection:"column", gap:6,
          padding:"10px 12px", border:"1px solid #1e293b", borderRadius:8, backgroundColor:"#020817",
        }}>
          <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1.2 }}>DISCOVERY SETTINGS</div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ color:"#64748b", fontSize:10 }}>Discovery Full Scan Interval (sec)</span>
            <input
              type="number"
              min={0}
              max={86400}
              value={discoveryIntervalSec}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDiscoveryIntervalSec(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:84, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#334155", fontSize:10 }}>
              current discovery schedule: {discoveryLabel}
            </span>
          </div>
        </div>
        <div style={{
          display:"flex", flexDirection:"column", gap:6,
          padding:"10px 12px", border:"1px solid #1e293b", borderRadius:8, backgroundColor:"#020817",
        }}>
          <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1.2 }}>LINK / NEIGHBOR UPDATE SETTINGS</div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ color:"#64748b", fontSize:10 }}>LLDP Link Poll Interval (sec)</span>
            <input
              type="number"
              min={0}
              max={3600}
              value={linkUpdateIntervalSec}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLinkUpdateIntervalSec(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:84, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#334155", fontSize:10 }}>
              Set 0 to disable
            </span>
            <span style={{ color:"#334155", fontSize:10 }}>
              current link schedule: {linksLabel}
            </span>
          </div>
        </div>
        <div style={{
          display:"flex", flexDirection:"column", gap:6,
          padding:"10px 12px", border:"1px solid #1e293b", borderRadius:8, backgroundColor:"#020817",
        }}>
          <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1.2 }}>MAC AT PORT UPDATE SETTINGS</div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ color:"#64748b", fontSize:10 }}>MAC Poll Interval (sec)</span>
            <input
              type="number"
              min={0}
              max={3600}
              value={macUpdateIntervalSec}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMacUpdateIntervalSec(e.target.value)}
              disabled={settingsLoading || settingsSaving || scanning}
              style={{
                width:84, backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
                color:"#e2e8f0", padding:"5px 8px", fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              }}
            />
            <span style={{ color:"#334155", fontSize:10 }}>
              Set 0 to disable
            </span>
            <span style={{ color:"#334155", fontSize:10 }}>
              current MAC schedule: {macsLabel}
            </span>
          </div>
        </div>
        {/* Save intervals button + error display */}
        <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <button
            onClick={saveScanSettings}
            disabled={settingsLoading || settingsSaving || scanning}
            style={{
              border:"1px solid #1e293b", background:"#0f172a", color:"#94a3b8",
              borderRadius:6, padding:"5px 10px", cursor:(settingsLoading || settingsSaving || scanning)?"default":"pointer",
              fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
              opacity:(settingsLoading || settingsSaving || scanning)?0.6:1,
            }}
          >{settingsSaving ? "Saving..." : "Save Scan Settings"}</button>
          {settingsError && (
            <span style={{ color:"#f87171", fontSize:10 }}>{settingsError}</span>
          )}
        </div>
        {/* Discovery IP Ranges */}
        <div style={{
          display:"flex", flexDirection:"column", gap:10,
          padding:"10px 12px", border:"1px solid #1e293b", borderRadius:8, backgroundColor:"#020817",
        }}>
          <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1.2 }}>DISCOVERY IP RANGES</div>
          <div style={{ color:"#475569", fontSize:10, lineHeight:1.6 }}>
            IPs or CIDR ranges scanned automatically during discovery. Responding hosts are added as credentials. One entry per line (e.g. 192.168.1.0/24).
          </div>
          {/* Existing ranges as removable chips */}
          {discoveryRanges.length > 0 && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {discoveryRanges.map((r, idx) => (
                <span key={idx} style={{
                  display:"inline-flex", alignItems:"center", gap:5,
                  backgroundColor:"#0c1220", border:"1px solid #1e3a52", borderRadius:5,
                  padding:"2px 8px", fontSize:11, color:"#7dd3fc", fontFamily:"monospace",
                }}>
                  {r}
                  <button
                    onClick={() => removeRange(idx)}
                    style={{
                      background:"none", border:"none", color:"#64748b", cursor:"pointer",
                      padding:0, fontSize:13, lineHeight:1, fontFamily:"inherit",
                    }}
                    title="Remove"
                  >x</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            rows={4}
            value={rangesInput}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRangesInput(e.target.value)}
            placeholder={"192.168.1.0/24\n10.0.0.0/16\n172.16.5.42"}
            disabled={settingsLoading || rangesSaving}
            style={{
              backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:5,
              color:"#e2e8f0", padding:"6px 8px", fontFamily:"monospace", fontSize:11,
              resize:"vertical", minHeight:70,
            }}
          />
          {rangesError && (
            <div style={{ color:"#f87171", fontSize:11 }}>{rangesError}</div>
          )}
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <button
              onClick={saveDiscoveryRanges}
              disabled={settingsLoading || rangesSaving}
              style={{
                border:"1px solid #1e293b", background:"#0f172a", color:"#94a3b8",
                borderRadius:6, padding:"5px 12px", cursor:(settingsLoading || rangesSaving)?"default":"pointer",
                fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
                opacity:(settingsLoading || rangesSaving)?0.6:1,
              }}
            >{rangesSaving ? "Saving..." : "Save Ranges"}</button>
            <button
              onClick={runDryRun}
              disabled={settingsLoading || dryRunLoading || discoveryRanges.length === 0}
              style={{
                border:"1px solid #164e63", background:"#083344", color:"#22d3ee",
                borderRadius:6, padding:"5px 12px",
                cursor:(settingsLoading || dryRunLoading || discoveryRanges.length === 0)?"default":"pointer",
                fontFamily:"'Inter', system-ui, sans-serif", fontSize:11,
                opacity:(settingsLoading || dryRunLoading || discoveryRanges.length === 0)?0.5:1,
              }}
            >{dryRunLoading ? "Scanning..." : "Dry Run"}</button>
            {discoveryRanges.length > 0 && (
              <span style={{ color:"#334155", fontSize:10 }}>{discoveryRanges.length} range(s) active</span>
            )}
          </div>
          {/* Dry run results */}
          {dryRunResult && (
            <div style={{
              marginTop:8, padding:"10px 12px",
              border:"1px solid #1e3a52", borderRadius:8, backgroundColor:"#0c1220",
            }}>
              <div style={{ color:"#94a3b8", fontSize:10, fontWeight:700, letterSpacing:1, marginBottom:8 }}>
                DRY RUN RESULT - {dryRunResult.found ?? 0} host(s) found, {dryRunResult.scanned ?? 0} probed - {dryRunResult.total_duration_ms != null ? ((dryRunResult.total_duration_ms / 1000).toFixed(1) + "s") : ""}
              </div>
              {(dryRunResult.preview || []).length === 0 ? (
                <div style={{ color:"#475569", fontSize:11 }}>No responding hosts found in configured ranges.</div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                  {(dryRunResult.preview || []).map((item, i) => (
                    <div key={i} style={{
                      display:"flex", alignItems:"center", gap:8, flexWrap:"wrap",
                      padding:"4px 8px", borderRadius:5,
                      backgroundColor: item.no_profile_suitable ? "#1c0a0a" : item.already_exists ? "#0a1a0a" : "#0a1220",
                      border: `1px solid ${item.no_profile_suitable ? "#7f1d1d" : item.already_exists ? "#14532d" : "#1e3a52"}`,
                    }}>
                      <span style={{ color:"#7dd3fc", fontFamily:"monospace", fontSize:11, minWidth:120 }}>{item.ip}</span>
                      <span style={{ color:"#94a3b8", fontSize:11 }}>{item.sys_name || "-"}</span>
                      {item.already_exists && (
                        <span style={{ color:"#4ade80", fontSize:9, fontWeight:700, letterSpacing:1, padding:"1px 5px", borderRadius:3, backgroundColor:"#14532d30", border:"1px solid #14532d" }}>existing</span>
                      )}
                      {item.no_profile_suitable && (
                        <span style={{ color:"#f87171", fontSize:9, fontWeight:700, letterSpacing:1, padding:"1px 5px", borderRadius:3, backgroundColor:"#7f1d1d30", border:"1px solid #7f1d1d" }}>no profile suitable</span>
                      )}
                      {!item.no_profile_suitable && !item.already_exists && (
                        <span style={{ color:"#22d3ee", fontSize:9, fontWeight:700, letterSpacing:1, padding:"1px 5px", borderRadius:3, backgroundColor:"#083344", border:"1px solid #164e63" }}>would create credential</span>
                      )}
                      {item.vendor && item.vendor !== "unknown" && (
                        <span style={{ color:"#64748b", fontSize:10 }}>{item.vendor}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {(dryRunResult.errors || []).length > 0 && (
                <div style={{ marginTop:8, color:"#f87171", fontSize:10 }}>
                  {dryRunResult.errors!.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={runScan}
            disabled={scanning}
            style={{
              ...btnStyle,
              opacity: scanning ? 0.6 : 1,
              cursor: scanning ? "wait" : "pointer",
            }}
          >{scanning ? "Scanning..." : "Run Scan"}</button>
          {scanning && activeJobId && (
            <button
              onClick={cancelScan}
              style={{
                border:"1px solid #7f1d1d", background:"#1c1917", color:"#f87171",
                borderRadius:6, padding:"10px 18px", cursor:"pointer",
                fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600,
              }}
            >Cancel</button>
          )}
          {scanning && (
            <span style={{ color: "#475569", fontSize: 10 }}>
              Job {activeJobId ? activeJobId.slice(0, 8) : "-"} is running...
            </span>
          )}
        </div>
      </div>

      {/* Latest result */}
      {scanResult && !scanning && (
        <div style={{
          backgroundColor: scanResult.errors?.length ? "#7f1d1d12" : "#14532d12",
          border: `1px solid ${scanResult.errors?.length ? "#7f1d1d" : "#14532d"}`,
          borderRadius: 8, padding: 14,
        }}>
          <div style={{
            color: scanResult.errors?.length ? "#f87171" : "#4ade80",
            fontSize: 11, fontWeight: 600, marginBottom: 8,
          }}>
            {scanResult.errors?.length ? "Scan completed with errors" : "Scan completed successfully"}
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>SCANNED</span>
              <span style={{ color: "#e2e8f0", fontSize: 16, fontWeight: 700 }}>{scanResult.scanned ?? 0}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>FOUND</span>
              <span style={{ color: "#22d3ee", fontSize: 16, fontWeight: 700 }}>{scanResult.found ?? 0}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>LINKS</span>
              <span style={{ color: "#a78bfa", fontSize: 16, fontWeight: 700 }}>{scanResult.links ?? 0}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>TOTAL TIME</span>
              <span style={{ color: "#7dd3fc", fontSize: 16, fontWeight: 700 }}>{fmtDuration(scanResult.total_duration_ms)}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "#475569", fontSize: 9, letterSpacing: 1 }}>WORKERS</span>
              <span style={{ color: "#94a3b8", fontSize: 16, fontWeight: 700 }}>{scanResult.max_workers ?? 1}</span>
            </div>
          </div>
          {(scanResult.switch_metrics?.length ?? 0) > 0 && (
            <div style={{ marginTop: 10, borderTop: "1px solid #1e293b", paddingTop: 8 }}>
              <div style={{ color: "#94a3b8", fontSize: 9, letterSpacing: 1, marginBottom: 6 }}>
                SWITCH DURATIONS
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:180, overflowY:"auto" }}>
                {scanResult.switch_metrics!.map((m, i) => (
                  <div key={`${m.ip}-${i}`} style={{
                    display:"grid", gridTemplateColumns:"1fr 90px 60px", gap:8,
                    fontSize:10, padding:"4px 0", borderBottom:i < scanResult.switch_metrics!.length - 1 ? "1px solid #0f172a" : "none",
                  }}>
                    <span style={{ color:m.success ? "#94a3b8" : "#fda4af", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {(m.label ? `${m.label} ` : "") + `(${m.ip})`}
                    </span>
                    <span style={{ color:"#7dd3fc", textAlign:"right" }}>{fmtDuration(m.duration_ms)}</span>
                    <span style={{ color:m.success ? "#4ade80" : "#f87171", textAlign:"right" }}>{m.success ? "OK" : "FAIL"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(scanResult.errors?.length ?? 0) > 0 && (
            <div style={{ marginTop: 10, borderTop: "1px solid #7f1d1d33", paddingTop: 8 }}>
              <div style={{ color: "#f87171", fontSize: 9, letterSpacing: 1, marginBottom: 4 }}>ERRORS</div>
              {scanResult.errors!.map((e, i) => (
                <div key={i} style={{ color: "#fb7185", fontSize: 10, padding: "2px 0" }}>{e}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Session history */}
      <div style={{
        backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 10,
        padding: 14,
      }}>
        <div style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: 2, marginBottom: 10 }}>
          SCAN HISTORY (persisted)
        </div>
        {historyLoading ? (
          <div style={{ color: "#334155", fontSize: 10 }}>Loading...</div>
        ) : history.length === 0 ? (
          <div style={{ color: "#334155", fontSize: 10 }}>No scan runs yet</div>
        ) : history.map((h) => (
          <div key={h.id} style={{
            display: "flex", flexDirection:"column", alignItems: "stretch", gap: 4,
            padding: "6px 0", borderBottom: "1px solid #0f172a",
            fontSize: 10,
          }}>
            <div style={{display:"flex", alignItems:"center", gap: 12}}>
              <span style={{ color: "#334155", minWidth: 70 }}>{fmtTs(h.created_at)}</span>
              <span style={{ color: h.status === "finished" ? "#4ade80" : h.status === "cancelled" ? "#f59e0b" : "#f87171", minWidth: 22 }}>
                {h.status === "finished" ? "OK" : h.status === "cancelled" ? "CAN" : "ERR"}
              </span>
              <span style={{ color: "#94a3b8" }}>
                {h.found} switches, {h.links} links
                <span style={{ color: "#64748b" }}> - {fmtDuration(h.total_duration_ms)}</span>
                <span style={{ color: "#475569" }}> - w:{h.max_workers}</span>
                {(h.error_count ?? 0) > 0 && <span style={{ color: "#f87171" }}> ({h.error_count} errors)</span>}
              </span>
            </div>
            <div style={{display:"flex", gap:10, flexWrap:"wrap", paddingLeft:82, color:"#64748b"}}>
              <span style={{color:(h.new_devices?.length||0)>0?"#4ade80":"#64748b"}}>+dev {h.new_devices?.length || 0}</span>
              <span style={{color:(h.removed_devices?.length||0)>0?"#f87171":"#64748b"}}>-dev {h.removed_devices?.length || 0}</span>
              <span style={{color:(h.new_links?.length||0)>0?"#22d3ee":"#64748b"}}>+link {h.new_links?.length || 0}</span>
              <span style={{color:(h.removed_links?.length||0)>0?"#f59e0b":"#64748b"}}>-link {h.removed_links?.length || 0}</span>
            </div>
            {((h.new_devices?.length || 0) > 0 || (h.removed_devices?.length || 0) > 0) && (
              <div style={{paddingLeft:82, color:"#64748b", display:"flex", flexDirection:"column", gap:2}}>
                {(h.new_devices?.length ?? 0) > 0 && <div>new devices: {h.new_devices!.join(", ")}</div>}
                {(h.removed_devices?.length ?? 0) > 0 && <div>removed devices: {h.removed_devices!.join(", ")}</div>}
              </div>
            )}
            {((h.new_links?.length || 0) > 0 || (h.removed_links?.length || 0) > 0) && (
              <div style={{paddingLeft:82, color:"#64748b", display:"flex", flexDirection:"column", gap:2}}>
                {(h.new_links?.length ?? 0) > 0 && <div>new links: {h.new_links!.slice(0, 3).join(" | ")}{h.new_links!.length > 3 ? " ..." : ""}</div>}
                {(h.removed_links?.length ?? 0) > 0 && <div>removed links: {h.removed_links!.slice(0, 3).join(" | ")}{h.removed_links!.length > 3 ? " ..." : ""}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default EngineTabContent;
