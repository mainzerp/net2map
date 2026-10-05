import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, extractErrorMessage } from "../../../api";
import { queryKeys, useAppSettings, useInvalidateApi, useScanSettings } from "../../../hooks/api";
import { Button, Input } from "../../ui";
import { SectionHeader } from "../shared";

// ── ScanEngineConfig ─────────────────────────────────────────────────────────
// Engine settings (workers / timeout / retries) plus the discovery, link and
// MAC poll intervals. Loads from /api/scan-settings and /api/settings and
// saves both in one action.
function ScanEngineConfig() {
  const { data: scanSettings, isLoading: scanLoading } = useScanSettings();
  const { data: appSettings, isLoading: appLoading } = useAppSettings();
  const { invalidate } = useInvalidateApi();

  const [scanWorkers, setScanWorkers] = useState<number | string>(4);
  const [snmpTimeout, setSnmpTimeout] = useState<number | string>(3);
  const [snmpRetries, setSnmpRetries] = useState<number | string>(1);
  const [discoveryIntervalSec, setDiscoveryIntervalSec] = useState<number | string>(1800);
  const [linkUpdateIntervalSec, setLinkUpdateIntervalSec] = useState<number | string>(30);
  const [macUpdateIntervalSec, setMacUpdateIntervalSec] = useState<number | string>(30);
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

    const settingsList = appSettings ?? [];
    const discovery = settingsList.find((s) => s.key === "discovery_interval_sec");
    const legacyPorts = settingsList.find((s) => s.key === "port_update_interval_sec");
    const links = settingsList.find((s) => s.key === "link_update_interval_sec");
    const macs = settingsList.find((s) => s.key === "mac_update_interval_sec");
    const fallbackPortValue = legacyPorts?.value != null ? Number(legacyPorts.value) : 30;
    if (discovery?.value != null) setDiscoveryIntervalSec(Number(discovery.value));
    setLinkUpdateIntervalSec(links?.value != null ? Number(links.value) : fallbackPortValue);
    setMacUpdateIntervalSec(macs?.value != null ? Number(macs.value) : fallbackPortValue);
  }, [scanLoading, appLoading, scanSettings, appSettings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const normalized = {
        max_workers: Math.max(1, Math.min(128, Number(scanWorkers) || 1)),
        snmp_timeout: Math.max(1, Math.min(30, Number(snmpTimeout) || 3)),
        snmp_retries: Math.max(0, Math.min(10, Number(snmpRetries) || 1)),
        discovery_interval_sec: Math.max(0, Math.min(86400, Number(discoveryIntervalSec) || 0)),
        link_update_interval_sec: Math.max(0, Math.min(3600, Number(linkUpdateIntervalSec) || 0)),
        mac_update_interval_sec: Math.max(0, Math.min(3600, Number(macUpdateIntervalSec) || 0)),
      };

      await api.put("/api/scan-settings", {
        max_workers: normalized.max_workers,
        snmp_timeout: normalized.snmp_timeout,
        snmp_retries: normalized.snmp_retries,
      });
      await api.put("/api/settings/discovery_interval_sec", { value: String(normalized.discovery_interval_sec) });
      await api.put("/api/settings/link_update_interval_sec", { value: String(normalized.link_update_interval_sec) });
      await api.put("/api/settings/mac_update_interval_sec", { value: String(normalized.mac_update_interval_sec) });
      // Intentional migration sync: the backend still reads the legacy
      // port_update_interval_sec key as a fallback, so keep it in step.
      await api.put("/api/settings/port_update_interval_sec", { value: String(normalized.mac_update_interval_sec) });
      return normalized;
    },
    onSuccess: (normalized) => {
      // Re-sync the form with the clamped values that were actually saved.
      setScanWorkers(normalized.max_workers);
      setSnmpTimeout(normalized.snmp_timeout);
      setSnmpRetries(normalized.snmp_retries);
      setDiscoveryIntervalSec(normalized.discovery_interval_sec);
      setLinkUpdateIntervalSec(normalized.link_update_interval_sec);
      setMacUpdateIntervalSec(normalized.mac_update_interval_sec);
      invalidate(queryKeys.scanSettings, queryKeys.appSettings);
    },
    onError: (ex) => setSettingsError(extractErrorMessage(ex)),
  });

  const save = () => {
    setSettingsError("");
    saveMutation.mutate();
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
          <span className="text-muted text-[10px] opacity-70">
            {settingsLoading ? "Loading settings..." : "1-128 workers"}
          </span>
        </div>
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
