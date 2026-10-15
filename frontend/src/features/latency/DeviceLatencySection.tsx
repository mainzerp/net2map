import { deviceDisplayName } from "../../utils/deviceSearch";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, extractErrorMessage, getStoredUser } from "../../api";
import { queryKeys, useLatencyHistory, useLatencySummary } from "../../hooks/api";
import { useToast } from "../../components/ToastProvider";
import { Badge, Sparkline } from "../../components/ui";
import type { LatencyRange, TopologyNode } from "../../types";
import { FactList, InspectorSection } from "../inspector/parts";
import { RangeSwitch } from "./RangeSwitch";
import {
  formatMs,
  formatPct,
  latencyBadgeTone,
  latencySparklineTone,
  latencyStatusLabel,
} from "./latency";

// "Latency" block of the device inspector: current RTT / jitter / loss /
// baseline from the monitor summary, the device's RTT history and the
// per-device "Monitor latency" opt-in (hidden for read-only viewers).

export function DeviceLatencySection({ device }: { device: TopologyNode }) {
  const summaryQuery = useLatencySummary();
  const [range, setRange] = useState<LatencyRange>("1h");
  const historyQuery = useLatencyHistory({ range, deviceId: device.id });
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const canEdit = (getStoredUser()?.role ?? "viewer") !== "viewer";

  const summary = summaryQuery.data;
  const entry = summary?.devices.find((d) => d.device_id === device.id) ?? null;
  const status = entry?.status ?? "unknown";
  const monitored = device.latency_monitored === true;
  const [pending, setPending] = useState<boolean | null>(null);
  const checked = pending ?? monitored;

  const toggleMutation = useMutation({
    mutationFn: (next: boolean) => api.patch(`/api/topology/devices/${device.id}/meta`, { latency_monitored: next }),
    onMutate: (next) => setPending(next),
    // Returning the promise makes React Query wait for the refetches before
    // onSettled, so the checkbox never flips back to the stale server value.
    onSuccess: () =>
      Promise.all(
        [
          queryKeys.topology,
          queryKeys.stats,
          queryKeys.devices,
          queryKeys.racks,
          queryKeys.latencySummary,
          queryKeys.latencyHistory(),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    onError: (ex) => addToast(extractErrorMessage(ex) || "Failed to update latency monitoring", "error"),
    onSettled: () => setPending(null),
  });

  const values = (historyQuery.data?.points ?? []).map((p) => p.rtt_ms);
  const hasHistory = values.some((v) => v != null);

  return (
    <InspectorSection
      title="Latency"
      aside={
        entry ? (
          <Badge tone={latencyBadgeTone(status)} data-testid="latency-status">
            {latencyStatusLabel(status)}
          </Badge>
        ) : undefined
      }
    >
      {summary && !summary.enabled && (
        <div className="mb-2 text-[11px] text-muted">The latency monitor is disabled in Settings.</div>
      )}
      {entry ? (
        <FactList
          facts={[
            { label: "RTT", value: formatMs(entry.rtt_ms), mono: true },
            { label: "Jitter", value: formatMs(entry.jitter_ms), mono: true },
            { label: "Loss", value: formatPct(entry.loss_pct), mono: true },
            { label: "Baseline", value: formatMs(entry.baseline_ms), mono: true },
          ]}
        />
      ) : (
        summary?.enabled && <div className="text-xs text-muted">No latency data for this device</div>
      )}

      {summary?.enabled && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted">RTT history</span>
            <RangeSwitch value={range} onChange={setRange} label="Device latency range" />
          </div>
          {hasHistory ? (
            <Sparkline
              values={values}
              area
              height={36}
              tone={latencySparklineTone(status)}
              baseline={entry?.baseline_ms ?? null}
              ariaLabel={`Round-trip time of ${deviceDisplayName(device)}, last ${range}`}
            />
          ) : (
            <div className="text-[11px] text-muted h-9 flex items-center">
              {historyQuery.isLoading ? "Loading history..." : "No history for this range yet"}
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex flex-col gap-1">
          <label className="inline-flex items-center gap-2 text-xs text-primary select-none cursor-pointer w-fit">
            <input
              type="checkbox"
              className="accent-accent cursor-pointer"
              checked={checked}
              disabled={toggleMutation.isPending}
              onChange={(e) => toggleMutation.mutate(e.target.checked)}
            />
            Monitor latency
          </label>
          {summary?.mode === "all" && (
            <span className="text-[11px] text-muted">
              All enabled devices are currently monitored; this flag only matters in "selected devices" mode.
            </span>
          )}
        </div>
      )}
    </InspectorSection>
  );
}
