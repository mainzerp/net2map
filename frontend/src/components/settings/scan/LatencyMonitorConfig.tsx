import { useEffect, useRef, useState } from "react";
import { extractErrorMessage } from "../../../api";
import { queryKeys, useAppSettings, useInvalidateApi, useUpdateAppSettings } from "../../../hooks/api";
import { Button, Input, Select } from "../../ui";
import { Field } from "../shared";
import type { LatencyMode } from "../../../types";

// ── LatencyMonitorConfig ─────────────────────────────────────────────────────
// Latency monitor settings, stored as AppSetting keys in one atomic PUT /api/settings:
// latency_enabled, latency_interval_sec, latency_pings, latency_mode and
// latency_retention_days. Ranges are validated client-side before saving.

export const LATENCY_LIMITS = {
  interval: { min: 5, max: 300, fallback: 10 },
  pings: { min: 1, max: 10, fallback: 3 },
  retention: { min: 1, max: 365, fallback: 30 },
} as const;

type Limit = { min: number; max: number };

/** Error text for an integer field outside its range, else null. */
export function rangeError(value: string, { min, max }: Limit): string | null {
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n) || n < min || n > max) return `Enter a whole number from ${min} to ${max}`;
  return null;
}

function LatencyMonitorConfig() {
  const { data: appSettings, isLoading } = useAppSettings();
  const { invalidate } = useInvalidateApi();

  const [enabled, setEnabled] = useState(false);
  const [intervalSec, setIntervalSec] = useState<string>(String(LATENCY_LIMITS.interval.fallback));
  const [pings, setPings] = useState<string>(String(LATENCY_LIMITS.pings.fallback));
  const [mode, setMode] = useState<LatencyMode>("all");
  const [retentionDays, setRetentionDays] = useState<string>(String(LATENCY_LIMITS.retention.fallback));
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  // Hydrate once when settings first arrive; refetches must not clobber edits.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (isLoading || hydratedRef.current) return;
    hydratedRef.current = true;
    const get = (key: string) => (appSettings ?? []).find((s) => s.key === key)?.value ?? null;
    setEnabled(get("latency_enabled") === "true");
    const interval = get("latency_interval_sec");
    if (interval != null) setIntervalSec(interval);
    const p = get("latency_pings");
    if (p != null) setPings(p);
    setMode(get("latency_mode") === "selected" ? "selected" : "all");
    const retention = get("latency_retention_days");
    if (retention != null) setRetentionDays(retention);
  }, [isLoading, appSettings]);

  const errors = {
    interval: rangeError(intervalSec, LATENCY_LIMITS.interval),
    pings: rangeError(pings, LATENCY_LIMITS.pings),
    retention: rangeError(retentionDays, LATENCY_LIMITS.retention),
  };
  const invalid = !!(errors.interval || errors.pings || errors.retention);

  const saveMutation = useUpdateAppSettings();

  const save = () => {
    setSaveError("");
    setSaved(false);
    if (invalid) return;
    saveMutation.mutate(
      {
        latency_enabled: enabled ? "true" : "false",
        latency_interval_sec: String(Number(intervalSec)),
        latency_pings: String(Number(pings)),
        latency_mode: mode,
        latency_retention_days: String(Number(retentionDays)),
      },
      {
        onSuccess: () => {
          setSaved(true);
          invalidate(queryKeys.latencySummary);
        },
        onError: (ex) => setSaveError(extractErrorMessage(ex)),
      },
    );
  };

  const busy = isLoading || saveMutation.isPending;

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[11px] text-muted">
        Pings every monitored device on a fixed interval and tracks round-trip time, jitter and packet loss.
      </p>
      <label className="inline-flex items-center gap-2 text-xs text-primary select-none cursor-pointer w-fit">
        <input
          type="checkbox"
          className="accent-accent cursor-pointer"
          checked={enabled}
          disabled={busy}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setSaved(false);
          }}
        />
        Enable latency monitor
      </label>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Interval (seconds, 5-300)" error={errors.interval ?? undefined}>
          <Input
            type="number"
            min={LATENCY_LIMITS.interval.min}
            max={LATENCY_LIMITS.interval.max}
            value={intervalSec}
            invalid={!!errors.interval}
            disabled={busy}
            onChange={(e) => setIntervalSec(e.target.value)}
          />
        </Field>
        <Field label="Pings per round (1-10)" error={errors.pings ?? undefined}>
          <Input
            type="number"
            min={LATENCY_LIMITS.pings.min}
            max={LATENCY_LIMITS.pings.max}
            value={pings}
            invalid={!!errors.pings}
            disabled={busy}
            onChange={(e) => setPings(e.target.value)}
          />
        </Field>
        <Field label="Monitored devices">
          <Select value={mode} disabled={busy} onChange={(e) => setMode(e.target.value === "selected" ? "selected" : "all")}>
            <option value="all">All enabled devices</option>
            <option value="selected">Selected devices only</option>
          </Select>
        </Field>
        <Field label="Retention (days, 1-365)" error={errors.retention ?? undefined}>
          <Input
            type="number"
            min={LATENCY_LIMITS.retention.min}
            max={LATENCY_LIMITS.retention.max}
            value={retentionDays}
            invalid={!!errors.retention}
            disabled={busy}
            onChange={(e) => setRetentionDays(e.target.value)}
          />
        </Field>
      </div>
      {mode === "selected" && (
        <p className="m-0 text-[11px] text-muted">
          Choose devices with "Monitor latency" in the device inspector.
        </p>
      )}

      <div className="flex items-center gap-2.5 flex-wrap">
        <Button onClick={save} disabled={busy || invalid}>
          {saveMutation.isPending ? "Saving..." : "Save Latency Settings"}
        </Button>
        {saved && !saveError && <span className="text-success text-[10px]">Saved</span>}
        {saveError && <span className="text-danger text-[10px]">{saveError}</span>}
      </div>
    </div>
  );
}

export default LatencyMonitorConfig;
