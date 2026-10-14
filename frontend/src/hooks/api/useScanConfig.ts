import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";

// ── Scan engine configuration (ScanSettingsTab) ─────────────────────────────

export interface ScanSettings {
  max_workers?: number;
  snmp_timeout?: number;
  snmp_retries?: number;
  snmp_bulk_size?: number;
  /** Days after which endpoints not seen are removed post-scan; 0 disables cleanup. */
  endpoint_retention_days?: number;
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

// Atomic multi-key update via PUT /api/settings ({key: value}); one request,
// so it counts once against the settings rate limit. Resolves with the full
// settings list, which also refreshes the appSettings cache.
export function useUpdateAppSettings() {
  const queryClient = useQueryClient();
  return useMutation<AppSetting[], unknown, Record<string, string>>({
    mutationFn: async (values) => {
      const data: unknown = await api.put("/api/settings", values);
      return Array.isArray(data) ? (data as AppSetting[]) : [];
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.appSettings, data);
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

/** PUT the discovery ranges; resolves with the normalized list the backend stored. */
export function useUpdateDiscoveryRanges(options?: MutationHookOptions<string[], string[]>) {
  return useApiMutation<string[], string[]>(
    async (lines) => {
      const resp = await api.put<{ ranges?: unknown } | null>("/api/discovery-ranges", { ranges: lines });
      return Array.isArray(resp?.ranges) ? (resp.ranges as string[]) : lines;
    },
    [queryKeys.discoveryRanges],
    options,
  );
}

export interface ScanEngineConfigValues {
  max_workers: number;
  snmp_timeout: number;
  snmp_retries: number;
  snmp_bulk_size: number;
  endpoint_retention_days: number;
  discovery_interval_sec: number;
  link_update_interval_sec: number;
  mac_update_interval_sec: number;
  vlan_update_interval_sec: number;
  stp_update_interval_sec: number;
}

/**
 * Save the scan engine settings (PUT /api/scan-settings) and the poll
 * intervals (PUT /api/settings/{key}). Resolves with the saved values.
 */
export function useUpdateScanEngineConfig(
  options?: MutationHookOptions<ScanEngineConfigValues, ScanEngineConfigValues>,
) {
  return useApiMutation<ScanEngineConfigValues, ScanEngineConfigValues>(
    async (normalized) => {
      await api.put("/api/scan-settings", {
        max_workers: normalized.max_workers,
        snmp_timeout: normalized.snmp_timeout,
        snmp_retries: normalized.snmp_retries,
        snmp_bulk_size: normalized.snmp_bulk_size,
        endpoint_retention_days: normalized.endpoint_retention_days,
      });
      await api.put("/api/settings/discovery_interval_sec", { value: String(normalized.discovery_interval_sec) });
      await api.put("/api/settings/link_update_interval_sec", { value: String(normalized.link_update_interval_sec) });
      await api.put("/api/settings/mac_update_interval_sec", { value: String(normalized.mac_update_interval_sec) });
      await api.put("/api/settings/vlan_update_interval_sec", { value: String(normalized.vlan_update_interval_sec) });
      await api.put("/api/settings/stp_update_interval_sec", { value: String(normalized.stp_update_interval_sec) });
      // Intentional migration sync: the backend still reads the legacy
      // port_update_interval_sec key as a fallback, so keep it in step.
      await api.put("/api/settings/port_update_interval_sec", { value: String(normalized.mac_update_interval_sec) });
      return normalized;
    },
    [queryKeys.scanSettings, queryKeys.appSettings],
    options,
  );
}

// ── Scan jobs ────────────────────────────────────────────────────────────────

// Job statuses that mean "still working" -- everything else (finished,
// failed, cancelled, skipped, dry_run) ends the poll loop.
export const ACTIVE_SCAN_JOB_STATUSES = new Set(["queued", "running"]);

export interface ScanJobStatus<TResult> {
  status?: string;
  result?: TResult;
}

export interface UseScanJobOptions {
  /** Poll interval in ms (also the delay between retries of a failed GET). */
  intervalMs?: number;
  /** Consecutive failed GETs after which polling gives up. */
  maxErrors?: number;
  /** Total time after which polling gives up. */
  maxDurationMs?: number;
}

/**
 * Polls GET /api/scan/jobs/{id} until the job leaves the active states.
 * React Query never overlaps fetches of the same query (in-flight guard);
 * a failed GET is retried up to maxErrors - 1 times before the query errors
 * and polling stops, and the whole poll is capped at maxDurationMs.
 */
export function useScanJob<TResult>(
  jobId: string | null,
  { intervalMs = 1500, maxErrors = 5, maxDurationMs = 10 * 60_000 }: UseScanJobOptions = {},
) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (!jobId) return undefined;
    const timer = setTimeout(() => setTimedOut(true), maxDurationMs);
    return () => clearTimeout(timer);
  }, [jobId, maxDurationMs]);

  const query = useQuery<ScanJobStatus<TResult> | null>({
    queryKey: queryKeys.scanJob(jobId),
    queryFn: () => api.get<ScanJobStatus<TResult> | null>(`/api/scan/jobs/${jobId}`),
    enabled: !!jobId && !timedOut,
    staleTime: 0,
    gcTime: 0,
    retry: Math.max(0, maxErrors - 1),
    retryDelay: intervalMs,
    refetchIntervalInBackground: true,
    refetchInterval: (q) => {
      if (q.state.status === "error") return false;
      const status = q.state.data?.status;
      if (status && !ACTIVE_SCAN_JOB_STATUSES.has(status)) return false;
      return intervalMs;
    },
  });

  const job = jobId ? query.data ?? null : null;
  const finished = !!job?.status && !ACTIVE_SCAN_JOB_STATUSES.has(job.status);
  return {
    job,
    finished,
    /** Polling gave up after maxErrors consecutive failed GETs. */
    error: jobId && query.isError ? query.error : null,
    /** Polling gave up after maxDurationMs without a final status. */
    timedOut: !!jobId && timedOut && !finished,
  };
}

/** POST /api/scan/jobs (full scan) or /api/scan/dry-run/jobs; resolves with the job id. */
export function useCreateScanJob(options?: MutationHookOptions<string, { dryRun?: boolean } | void>) {
  return useApiMutation<string, { dryRun?: boolean } | void>(
    async (vars) => {
      const path = vars && vars.dryRun ? "/api/scan/dry-run/jobs" : "/api/scan/jobs";
      const job: { job_id?: string } = await api.post(path, {});
      if (!job?.job_id) throw new Error(`${vars && vars.dryRun ? "Dry run" : "Scan"} job could not be created`);
      return job.job_id;
    },
    [],
    options,
  );
}

export function useCancelScanJob(options?: MutationHookOptions<unknown, string>) {
  return useApiMutation<unknown, string>(
    (jobId) => api.post(`/api/scan/jobs/${jobId}/cancel`, {}),
    [],
    options,
  );
}
