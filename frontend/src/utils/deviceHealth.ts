// Shared helpers for UPS / server health snapshots (see backend scanners/health.py).
import type { BadgeTone } from "../components/ui";
import type { DeviceHealth, DeviceType, HealthCondition, HealthStatus, TopologyNode } from "../types";

export const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  switch: "Switch",
  firewall: "Firewall",
  ups: "UPS",
  server: "Server",
  other: "Other device",
};

export function deviceTypeOf(device: Pick<TopologyNode, "device_type">): DeviceType {
  const t = device.device_type;
  return t === "firewall" || t === "ups" || t === "server" || t === "other" ? t : "switch";
}

// Devices whose ports are not the point of the faceplate / map node.
export function isPowerOrServer(device: Pick<TopologyNode, "device_type">): boolean {
  const t = deviceTypeOf(device);
  return t === "ups" || t === "server";
}

export function healthOf(device: Pick<TopologyNode, "health">): DeviceHealth | null {
  const h = device.health;
  return h && (h.kind === "ups" || h.kind === "server") ? h : null;
}

export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = {
  ok: "OK",
  warning: "Warning",
  critical: "Critical",
  unknown: "Unknown",
};

export function healthStatusTone(status: HealthStatus | null | undefined): BadgeTone {
  if (status === "ok") return "success";
  if (status === "warning") return "warning";
  if (status === "critical") return "danger";
  return "neutral";
}

// Tailwind background utility for a small status dot / bar fill.
export function healthStatusBg(status: HealthStatus | null | undefined): string {
  if (status === "ok") return "bg-success";
  if (status === "warning") return "bg-warning";
  if (status === "critical") return "bg-danger";
  return "bg-muted";
}

export function conditionTone(condition: HealthCondition | null | undefined): BadgeTone {
  if (condition === "ok") return "success";
  if (condition === "degraded") return "warning";
  if (condition === "failed") return "danger";
  return "neutral";
}

export function conditionLabel(condition: HealthCondition | null | undefined): string | null {
  if (condition == null) return null;
  return condition.charAt(0).toUpperCase() + condition.slice(1);
}

const OUTPUT_SOURCE_LABEL: Record<string, string> = {
  other: "Other",
  none: "No output",
  normal: "Utility (normal)",
  bypass: "Bypass",
  battery: "Battery",
  booster: "Boost",
  reducer: "Buck",
  parallel_capacity: "Parallel (capacity)",
  parallel_redundant: "Parallel (redundant)",
  high_efficiency: "High efficiency",
  maintenance_bypass: "Maintenance bypass",
  energy_saver: "Energy saver",
};

export function outputSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  return OUTPUT_SOURCE_LABEL[source] ?? source;
}

export function formatRuntime(minutes: number | null | undefined): string | null {
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatPercent(value: number | null | undefined): string | null {
  return value == null ? null : `${value}%`;
}

export function clampPercent(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

// Short reason line for a warning / critical snapshot, e.g. "UPS on battery,
// 64% charge" or "Server: fans degraded, storage failed".
export function healthSummary(health: DeviceHealth): string {
  if (health.kind === "ups") {
    const reasons: string[] = [];
    if (health.output_source === "none") reasons.push("no output power");
    else if (health.output_source === "battery" || (health.seconds_on_battery ?? 0) > 0) reasons.push("on battery");
    else if (health.output_source === "bypass" || health.output_source === "maintenance_bypass") reasons.push("on bypass");
    if (health.battery_status === "low" || health.battery_status === "depleted") reasons.push(`battery ${health.battery_status}`);
    if (health.alarms_present) reasons.push(`${health.alarms_present} alarm${health.alarms_present === 1 ? "" : "s"}`);
    if (health.charge_percent != null) reasons.push(`${health.charge_percent}% charge`);
    return `UPS ${reasons.join(", ") || HEALTH_STATUS_LABEL[health.status].toLowerCase()}`;
  }
  const parts = (
    [
      ["overall", health.overall],
      ["thermal", health.thermal],
      ["power", health.power_supply],
      ["fans", health.fans],
      ["storage", health.storage],
    ] as const
  )
    .filter(([, c]) => c === "degraded" || c === "failed")
    .map(([name, c]) => `${name} ${c}`);
  return `Server: ${parts.join(", ") || HEALTH_STATUS_LABEL[health.status].toLowerCase()}`;
}

// Health snapshots that need attention (dashboard / map badges).
export function needsAttention(device: Pick<TopologyNode, "health">): boolean {
  const h = healthOf(device);
  return h?.status === "warning" || h?.status === "critical";
}
