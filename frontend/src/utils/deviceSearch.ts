// Pure text filter for device pickers (settings assignment blocks).
import type { TopologyNode } from "../types";

export type SearchableDevice = Pick<TopologyNode, "id" | "ip" | "sys_name" | "vendor" | "model"> & {
  label?: string | null;
  display_name?: string | null;
  hostname?: string | null;
};

/** Fields deviceDisplayName reads; only ip is required. */
export type NamedDevice = {
  ip: string;
  sys_name?: string | null;
  hostname?: string | null;
  label?: string | null;
  display_name?: string | null;
};

export interface DeviceFilterResult<T> {
  /** Matches up to the limit, sorted by display name. */
  matches: T[];
  /** Number of all matches before the limit was applied. */
  total: number;
}

export const DEVICE_PICKER_LIMIT = 50;

// Manual display name, then the label (credential label), then sysName, the
// reverse DNS name and the IP. A label or sysName that only repeats the IP
// (ping-only devices, range discoveries without a name) is skipped.
export function deviceDisplayName(d: NamedDevice): string {
  const notIp = (v: string | null | undefined) => {
    const text = (v ?? "").trim();
    return text && text !== d.ip ? text : "";
  };
  return notIp(d.display_name) || notIp(d.label) || notIp(d.sys_name) || (d.hostname ?? "").trim() || d.ip;
}

function joinFields(fields: readonly (string | null | undefined)[]): string {
  return fields
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n")
    .toLowerCase();
}

function haystack(d: SearchableDevice): string {
  return joinFields([d.display_name, d.sys_name, d.hostname, d.ip, d.vendor, d.model, d.label]);
}

/**
 * True when every whitespace-separated token of ``query`` occurs
 * (case-insensitive) in at least one of ``fields``; an empty query matches.
 */
export function matchesQuery(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = joinFields(fields);
  return tokens.every((t) => text.includes(t));
}

/**
 * Case-insensitive substring filter over name, hostname, IP, vendor, model and
 * label. Whitespace-separated tokens must all match (in any field), so
 * "aruba 10.0.1" narrows by vendor and subnet. An empty query matches all.
 */
export function filterDevices<T extends SearchableDevice>(
  devices: readonly T[],
  query: string,
  limit: number = DEVICE_PICKER_LIMIT,
): DeviceFilterResult<T> {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = devices
    .filter((d) => {
      if (tokens.length === 0) return true;
      const text = haystack(d);
      return tokens.every((t) => text.includes(t));
    })
    .sort((a, b) => deviceDisplayName(a).localeCompare(deviceDisplayName(b)));
  return { matches: all.slice(0, Math.max(0, limit)), total: all.length };
}
