// Pure text filter for device pickers (settings assignment blocks).
import type { TopologyNode } from "../types";

export type SearchableDevice = Pick<TopologyNode, "id" | "ip" | "sys_name" | "vendor" | "model"> & {
  label?: string | null;
  hostname?: string | null;
};

export interface DeviceFilterResult<T> {
  /** Matches up to the limit, sorted by display name. */
  matches: T[];
  /** Number of all matches before the limit was applied. */
  total: number;
}

export const DEVICE_PICKER_LIMIT = 50;

// sysName, then the reverse DNS name, then the IP. A sysName that only repeats
// the IP (ping-only devices without a label) yields to the DNS name.
export function deviceDisplayName(d: Pick<SearchableDevice, "ip" | "sys_name" | "hostname">): string {
  const sysName = d.sys_name && d.sys_name !== d.ip ? d.sys_name : "";
  return sysName || d.hostname || d.ip;
}

function joinFields(fields: readonly (string | null | undefined)[]): string {
  return fields
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n")
    .toLowerCase();
}

function haystack(d: SearchableDevice): string {
  return joinFields([d.sys_name, d.hostname, d.ip, d.vendor, d.model, d.label]);
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
