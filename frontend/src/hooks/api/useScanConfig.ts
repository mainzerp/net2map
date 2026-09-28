import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "./keys";

// ── Scan engine configuration (ScanSettingsTab) ─────────────────────────────

export interface ScanSettings {
  max_workers?: number;
  snmp_timeout?: number;
  snmp_retries?: number;
  [key: string]: unknown;
}

export interface AppSetting {
  key: string;
  value?: string | null;
  [key: string]: unknown;
}

export interface ScanRunEntry {
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

export function useScanSettings() {
  return useQuery<ScanSettings>({
    queryKey: queryKeys.scanSettings,
    queryFn: async () => {
      const data: unknown = await api.get("/api/scan-settings");
      return (data ?? {}) as ScanSettings;
    },
  });
}

export function useAppSettings() {
  return useQuery<AppSetting[]>({
    queryKey: queryKeys.appSettings,
    queryFn: async () => {
      const data: unknown = await api.get("/api/settings");
      return Array.isArray(data) ? (data as AppSetting[]) : [];
    },
  });
}

export function useDiscoveryRanges() {
  return useQuery<string[]>({
    queryKey: queryKeys.discoveryRanges,
    queryFn: async () => {
      const data: unknown = await api.get("/api/discovery-ranges");
      const ranges = (data as { ranges?: unknown } | null)?.ranges;
      return Array.isArray(ranges) ? (ranges as string[]) : [];
    },
  });
}

export function useScanRuns(limit: number = 20) {
  return useQuery<ScanRunEntry[]>({
    // The limit is part of the fetch, so it must be part of the key;
    // prefix-based invalidation on queryKeys.scanRuns still matches.
    queryKey: [...queryKeys.scanRuns, limit],
    queryFn: async () => {
      const data: unknown = await api.get(`/api/scan-runs?limit=${limit}`);
      return Array.isArray(data) ? (data as ScanRunEntry[]) : [];
    },
  });
}
