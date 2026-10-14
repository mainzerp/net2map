import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { PingCandidate, PingOnlyAdoptResult, PingOnlyEntry, PingOnlySkipReason } from "../../types";
import { useInvalidateApi } from "./invalidate";
import { queryKeys } from "./keys";

// ── Ping-only devices ────────────────────────────────────────────────────────
// POST /api/credentials/ping-only creates a ping-only credential plus the
// device in one step. GET /api/ping-candidates lists hosts in the discovery
// ranges that answered ping but not SNMP; dismiss/restore hide or re-show them.

/** Human-readable reason for a skipped ping-only entry. */
export function pingOnlySkipLabel(reason: PingOnlySkipReason | string): string {
  switch (reason) {
    case "exists":
      return "Already managed";
    case "invalid":
      return "Invalid IP";
    case "duplicate":
      return "Duplicate entry";
    default:
      return String(reason);
  }
}

export function usePingCandidates(includeDismissed = false, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<PingCandidate[]>({
    queryKey: queryKeys.pingCandidates(includeDismissed),
    enabled,
    queryFn: async () => {
      const path = includeDismissed ? "/api/ping-candidates?include_dismissed=true" : "/api/ping-candidates";
      const data: unknown = await api.get(path);
      return Array.isArray(data) ? (data as PingCandidate[]) : [];
    },
  });
}

export function useAdoptPingOnly() {
  const { invalidate } = useInvalidateApi();
  return useMutation<PingOnlyAdoptResult, unknown, PingOnlyEntry[]>({
    mutationFn: async (entries) => {
      const data = await api.post<PingOnlyAdoptResult>("/api/credentials/ping-only", { entries });
      return { created: data?.created ?? [], skipped: data?.skipped ?? [] };
    },
    onSuccess: () =>
      invalidate(
        queryKeys.topology,
        queryKeys.stats,
        queryKeys.devices,
        queryKeys.credentials,
        queryKeys.endpoints,
        queryKeys.pingCandidates(),
      ),
  });
}

export function useDismissPingCandidates() {
  const { invalidate } = useInvalidateApi();
  return useMutation<{ dismissed: number }, unknown, number[]>({
    mutationFn: (ids) => api.post<{ dismissed: number }>("/api/ping-candidates/dismiss", { ids }),
    onSuccess: () => invalidate(queryKeys.pingCandidates()),
  });
}

export function useRestorePingCandidates() {
  const { invalidate } = useInvalidateApi();
  return useMutation<{ restored: number }, unknown, number[]>({
    mutationFn: (ids) => api.post<{ restored: number }>("/api/ping-candidates/restore", { ids }),
    onSuccess: () => invalidate(queryKeys.pingCandidates()),
  });
}
