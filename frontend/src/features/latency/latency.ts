// ── Latency monitor: pure presentation helpers ───────────────────────────────
// Formatting and status-to-tone mapping shared by the dashboard card, the
// inspector section and the topology latency layer. No React in here.

import type { BadgeTone, SparklineTone } from "../../components/ui";
import type { LatencyRange, LatencyStatus } from "../../types";

export const LATENCY_RANGES: readonly LatencyRange[] = ["1h", "24h", "7d"];

/** "0.4 ms", "3.2 ms", "12 ms", "--" for missing values. */
export function formatMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  if (value < 10) return `${(Math.round(value * 10) / 10).toFixed(1)} ms`;
  return `${Math.round(value)} ms`;
}

/** "0 %", "2.5 %", "--" for missing values. */
export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} %`;
}

// Severity rank: unknown is lowest so any measured status wins over it.
const SEVERITY: Record<LatencyStatus, number> = { unknown: 0, ok: 1, degraded: 2, loss: 3, down: 4 };

export function statusSeverity(status: LatencyStatus): number {
  return SEVERITY[status] ?? 0;
}

/** The more severe of two statuses (down > loss > degraded > ok > unknown). */
export function worstStatus(a: LatencyStatus, b: LatencyStatus): LatencyStatus {
  return statusSeverity(b) > statusSeverity(a) ? b : a;
}

/** Statuses that need a human look (listed on the dashboard card). */
export function isProblemStatus(status: LatencyStatus): boolean {
  return status === "degraded" || status === "loss" || status === "down";
}

const LABELS: Record<LatencyStatus, string> = {
  ok: "OK",
  degraded: "Degraded",
  loss: "Packet loss",
  down: "Down",
  unknown: "Unknown",
};

export function latencyStatusLabel(status: LatencyStatus): string {
  return LABELS[status] ?? LABELS.unknown;
}

export function latencyBadgeTone(status: LatencyStatus): BadgeTone {
  if (status === "ok") return "success";
  if (status === "degraded" || status === "loss") return "warning";
  if (status === "down") return "danger";
  return "neutral";
}

export function latencySparklineTone(status: LatencyStatus): SparklineTone {
  if (status === "ok") return "ok";
  if (status === "degraded" || status === "loss") return "warning";
  if (status === "down") return "danger";
  return "neutral";
}

export type LatencyEdgeTone = "success" | "warning" | "danger";

/** Edge tint for the topology latency layer; null keeps the default look. */
export function latencyEdgeTone(status: LatencyStatus): LatencyEdgeTone | null {
  if (status === "ok") return "success";
  if (status === "degraded" || status === "loss") return "warning";
  if (status === "down") return "danger";
  return null;
}

export const LATENCY_EDGE_COLOR: Record<LatencyEdgeTone, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
};
