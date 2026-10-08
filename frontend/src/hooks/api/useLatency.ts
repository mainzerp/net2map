import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type {
  LatencyDevice,
  LatencyHistory,
  LatencyPoint,
  LatencyRange,
  LatencyStatus,
  LatencySummary,
} from "../../types";
import { queryKeys } from "./keys";

// ── Latency monitor data hooks ───────────────────────────────────────────────
// GET /api/latency/summary (polled at the monitor interval) and
// GET /api/latency/history (polled once a minute). Responses are normalized
// defensively so a partial or older backend never crashes the views.

const MIN_REFETCH_MS = 5000;
const HISTORY_REFETCH_MS = 60_000;
const STATUSES: readonly LatencyStatus[] = ["ok", "degraded", "loss", "down", "unknown"];

/** Poll interval for the summary: the monitor interval, at least 5 s. */
export function latencyRefetchMs(intervalSec: number | null | undefined): number {
  const sec = typeof intervalSec === "number" && Number.isFinite(intervalSec) ? intervalSec : 10;
  return Math.max(MIN_REFETCH_MS, sec * 1000);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function normalizeDevice(raw: unknown): LatencyDevice | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const id = num(d.device_id);
  if (id == null) return null;
  const status = STATUSES.includes(d.status as LatencyStatus) ? (d.status as LatencyStatus) : "unknown";
  return {
    device_id: id,
    name: str(d.name) ?? "",
    ip: str(d.ip) ?? "",
    rtt_ms: num(d.rtt_ms),
    jitter_ms: num(d.jitter_ms),
    loss_pct: num(d.loss_pct),
    baseline_ms: num(d.baseline_ms),
    status,
    updated_at: str(d.updated_at),
  };
}

export function normalizeLatencySummary(raw: unknown): LatencySummary {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const n = s.network && typeof s.network === "object" ? (s.network as Record<string, unknown>) : {};
  const devices = Array.isArray(s.devices)
    ? s.devices.map(normalizeDevice).filter((d): d is LatencyDevice => d !== null)
    : [];
  return {
    enabled: s.enabled === true,
    interval_sec: num(s.interval_sec) ?? 10,
    mode: s.mode === "selected" ? "selected" : "all",
    monitor_alive: s.monitor_alive === true,
    updated_at: str(s.updated_at),
    network: {
      median_ms: num(n.median_ms),
      p95_ms: num(n.p95_ms),
      loss_pct: num(n.loss_pct),
      targets: num(n.targets) ?? 0,
      reachable: num(n.reachable) ?? 0,
      degraded: num(n.degraded) ?? 0,
    },
    devices,
  };
}

export function useLatencySummary() {
  return useQuery<LatencySummary>({
    queryKey: queryKeys.latencySummary,
    queryFn: async () => normalizeLatencySummary(await api.get<unknown>("/api/latency/summary")),
    refetchInterval: (query) => latencyRefetchMs(query.state.data?.interval_sec),
    refetchIntervalInBackground: false,
  });
}

function normalizePoint(raw: unknown): LatencyPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const ts = str(p.ts);
  if (ts == null) return null;
  return { ts, rtt_ms: num(p.rtt_ms), jitter_ms: num(p.jitter_ms), loss_pct: num(p.loss_pct) };
}

export function useLatencyHistory({ range, deviceId }: { range: LatencyRange; deviceId?: number | null }) {
  return useQuery<LatencyHistory>({
    queryKey: queryKeys.latencyHistory({ range, deviceId }),
    queryFn: async () => {
      const query = new URLSearchParams({ range });
      if (deviceId != null) query.set("device_id", String(deviceId));
      const raw = await api.get<unknown>(`/api/latency/history?${query.toString()}`);
      const h = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      return {
        range: str(h.range) ?? range,
        device_id: num(h.device_id),
        bucket_sec: num(h.bucket_sec) ?? 0,
        points: Array.isArray(h.points)
          ? h.points.map(normalizePoint).filter((p): p is LatencyPoint => p !== null)
          : [],
      };
    },
    refetchInterval: HISTORY_REFETCH_MS,
    refetchIntervalInBackground: false,
  });
}
