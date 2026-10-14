import { useState, useEffect, useRef } from "react";
import { extractErrorMessage } from "../../../api";
import { useAppSettings, useScanSettings, useUpdateScanEngineConfig } from "../../../hooks/api";
import { Button, Input } from "../../ui";
import { SectionHeader } from "../shared";

// ── ScanEngineConfig ─────────────────────────────────────────────────────────
// Engine settings (workers / timeout / retries / bulk size) plus the discovery, link and
// MAC poll intervals and the VLAN / STP refresh intervals. Loads from /api/scan-settings and /api/settings and
// saves both in one action.
function ScanEngineConfig() {
  const { data: scanSettings, isLoading: scanLoading } = useScanSettings();
  const { data: appSettings, isLoading: appLoading } = useAppSettings();

  const [scanWorkers, setScanWorkers] = useState<number | string>(4);
  const [snmpTimeout, setSnmpTimeout] = useState<number | string>(3);
  const [snmpRetries, setSnmpRetries] = useState<number | string>(1);
  const [snmpBulkSize, setSnmpBulkSize] = useState<number | string>(25);
  const [endpointRetentionDays, setEndpointRetentionDays] = useState<number | string>(30);
  const [discoveryIntervalSec, setDiscoveryIntervalSec] = useState<number | string>(1800);
  const [linkUpdateIntervalSec, setLinkUpdateIntervalSec] = useState<number | string>(60);
  const [macUpdateIntervalSec, setMacUpdateIntervalSec] = useState<number | string>(300);
  const [vlanUpdateIntervalSec, setVlanUpdateIntervalSec] = useState<number | string>(1800);
  const [stpUpdateIntervalSec, setStpUpdateIntervalSec] = useState<number | string>(300);
  const [settingsError, setSettingsError] = useState<string>("");

  const settingsLoading = scanLoading || appLoading;

  // Hydrate local form state once when both settings queries first arrive;
  // later refetches must not clobber unsaved edits.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (scanLoading || appLoading || hydratedRef.current) return;
    hydratedRef.current = true;
    if (scanSettings?.max_workers != null) setScanWorkers(Number(scanSettings.max_workers));
    if (scanSettings?.snmp_timeout != null) setSnmpTimeout(Number(scanSettings.snmp_timeout));
    if (scanSettings?.snmp_retries != null) setSnmpRetries(Number(scanSettings.snmp_retries));
    if (scanSettings?.snmp_bulk_size != null) setSnmpBulkSize(Number(scanSettings.snmp_bulk_size));
    if (scanSettings?.endpoint_retention_days != null) setEndpointRetentionDays(Number(scanSettings.endpoint_retention_days));

    const settingsList = appSettings ?? [];
    const discovery = settingsList.find((s) => s.key === "discovery_interval_sec");
    const legacyPorts = settingsList.find((s) => s.key === "port_update_interval_sec");
    const links = settingsList.find((s) => s.key === "link_update_interval_sec");
    const macs = settingsList.find((s) => s.key === "mac_update_interval_sec");
    const vlan = settingsList.find((s) => s.key === "vlan_update_interval_sec");
    const stp = settingsList.find((s) => s.key === "stp_update_interval_sec");
    const legacyValue = legacyPorts?.value != null ? Number(legacyPorts.value) : null;
    if (discovery?.value != null) setDiscoveryIntervalSec(Number(discovery.value));
    setLinkUpdateIntervalSec(links?.value != null ? Number(links.value) : legacyValue ?? 60);
    setMacUpdateIntervalSec(macs?.value != null ? Number(macs.value) : legacyValue ?? 300);
    if (vlan?.value != null) setVlanUpdateIntervalSec(Number(vlan.value));
    if (stp?.value != null) setStpUpdateIntervalSec(Number(stp.value));
  }, [scanLoading, appLoading, scanSettings, appSettings]);

  const saveMutation = useUpdateScanEngineConfig({
    onSuccess: (normalized) => {
      // Re-sync the form with the clamped values that were actually saved.
      setScanWorkers(normalized.max_workers);
      setSnmpTimeout(normalized.snmp_timeout);
      setSnmpRetries(normalized.snmp_retries);
      setSnmpBulkSize(normalized.snmp_bulk_size);
      setEndpointRetentionDays(normalized.endpoint_retention_days);
      setDiscoveryIntervalSec(normalized.discovery_interval_sec);
      setLinkUpdateIntervalSec(normalized.link_update_interval_sec);
      setMacUpdateIntervalSec(normalized.mac_update_interval_sec);
      setVlanUpdateIntervalSec(normalized.vlan_update_interval_sec);
      setStpUpdateIntervalSec(normalized.stp_update_interval_sec);
    },
    onError: (ex) => setSettingsError(extractErrorMessage(ex)),
  });

  const save = () => {
    setSettingsError("");
    // 0 is a valid retention (cleanup disabled); only an empty or invalid
    // field falls back to the default.
    const retention = Number(endpointRetentionDays);
    saveMutation.mutate({
      max_workers: Math.max(1, Math.min(128, Number(scanWorkers) || 1)),
      snmp_timeout: Math.max(1, Math.min(30, Number(snmpTimeout) || 3)),
      snmp_retries: Math.max(0, Math.min(10, Number(snmpRetries) || 1)),
      snmp_bulk_size: Math.max(5, Math.min(100, Number(snmpBulkSize) || 25)),
      endpoint_retention_days:
        String(endpointRetentionDays).trim() === "" || !Number.isFinite(retention)
          ? 30
          : Math.max(0, Math.min(3650, Math.round(retention))),
      discovery_interval_sec: Math.max(0, Math.min(86400, Number(discoveryIntervalSec) || 0)),
      link_update_interval_sec: Math.max(0, Math.min(3600, Number(linkUpdateIntervalSec) || 0)),
      mac_update_interval_sec: Math.max(0, Math.min(3600, Number(macUpdateIntervalSec) || 0)),
      vlan_update_interval_sec: Math.max(0, Math.min(86400, Number(vlanUpdateIntervalSec) || 0)),
      stp_update_interval_sec: Math.max(0, Math.min(86400, Number(stpUpdateIntervalSec) || 0)),
    });
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
  const refreshLabel = (value: number | string) => {
    const seconds = Math.max(0, Number(value) || 0);
    return seconds === 0 ? "manual full scans only" : `at most every ${seconds}s`;
  };

  const busy = settingsLoading || saveMutation.isPending;

  const numberInput = (
    value: number | string,
    onChange: (v: string) => void,
    min: number,
    max: number,
    widthClass: string,
  ) => (
    <div className={widthClass}>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy}
      />
    </div>
  );

  const intervalInput = (
    label: string,
    value: number | string,
    onChange: (v: string) => void,
    max: number,
    hint: string,
  ) => (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-muted text-[10px]">{label}</span>
      {numberInput(value, onChange, 0, max, "w-[84px]")}
      <span className="text-muted text-[10px] opacity-70">{hint}</span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="p-3 rounded-card bg-surface border border-line flex flex-col gap-2">
        <SectionHeader>GENERAL ENGINE SETTINGS</SectionHeader>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-muted text-[10px]">Parallel Workers (Hosts)</span>
          {numberInput(scanWorkers, setScanWorkers, 1, 128, "w-[60px]")}
          <span className="text-muted text-[10px] ml-2">Timeout (s)</span>
          {numberInput(snmpTimeout, setSnmpTimeout, 1, 30, "w-[60px]")}
          <span className="text-muted text-[10px] ml-2">Retries</span>
          {numberInput(snmpRetries, setSnmpRetries, 0, 10, "w-[60px]")}
          <span className="text-muted text-[10px] ml-2">Bulk Size</span>
          {numberInput(snmpBulkSize, setSnmpBulkSize, 5, 100, "w-[60px]")}
          <span className="text-muted text-[10px] opacity-70">
            {settingsLoading ? "Loading settings..." : "1-128 workers; bulk size = rows per SNMP request (5-100)"}
          </span>
        </div>
        {intervalInput(
          "Endpoint retention (days)",
          endpointRetentionDays,
          setEndpointRetentionDays,
          3650,
          "Endpoints not seen for this many days are removed after a successful scan. 0 disables cleanup.",
        )}
      </div>

      <div className="p-3 rounded-card bg-surface border border-line flex flex-col gap-2">
        <SectionHeader>DISCOVERY SETTINGS</SectionHeader>
        {intervalInput(
          "Discovery Full Scan Interval (sec)",
          discoveryIntervalSec,
          setDiscoveryIntervalSec,
          86400,
          `current discovery schedule: ${discoveryLabel}`,
        )}
      </div>

      <div className="p-3 rounded-card bg-surface border border-line flex flex-col gap-2">
        <SectionHeader>LINK / NEIGHBOR UPDATE SETTINGS</SectionHeader>
        {intervalInput(
          "LLDP Link Poll Interval (sec)",
          linkUpdateIntervalSec,
          setLinkUpdateIntervalSec,
          3600,
          `Set 0 to disable - current link schedule: ${linksLabel}`,
        )}
      </div>

      <div className="p-3 rounded-card bg-surface border border-line flex flex-col gap-2">
        <SectionHeader>MAC AT PORT UPDATE SETTINGS</SectionHeader>
        {intervalInput(
          "MAC Poll Interval (sec)",
          macUpdateIntervalSec,
          setMacUpdateIntervalSec,
          3600,
          `Set 0 to disable - current MAC schedule: ${macsLabel}`,
        )}
      </div>

      <div className="p-3 rounded-card bg-surface border border-line flex flex-col gap-2">
        <SectionHeader>VLAN / SPANNING TREE UPDATE SETTINGS</SectionHeader>
        <span className="text-muted text-[10px] opacity-70">
          Refreshed during MAC polls once the interval has passed; manual full scans always refresh.
        </span>
        {intervalInput(
          "VLAN Refresh Interval (sec)",
          vlanUpdateIntervalSec,
          setVlanUpdateIntervalSec,
          86400,
          `Set 0 for manual full scans only - current: ${refreshLabel(vlanUpdateIntervalSec)}`,
        )}
        {intervalInput(
          "STP Refresh Interval (sec)",
          stpUpdateIntervalSec,
          setStpUpdateIntervalSec,
          86400,
          `Set 0 for manual full scans only - current: ${refreshLabel(stpUpdateIntervalSec)}`,
        )}
      </div>

      <div className="flex items-center gap-2.5 flex-wrap">
        <Button onClick={save} disabled={busy}>
          {saveMutation.isPending ? "Saving..." : "Save Scan Settings"}
        </Button>
        {settingsError && <span className="text-danger text-[10px]">{settingsError}</span>}
      </div>
    </div>
  );
}

export default ScanEngineConfig;
