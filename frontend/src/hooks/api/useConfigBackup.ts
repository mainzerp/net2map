import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import type { MutationHookOptions } from "./mutation";

// ── Global config backup and restore (ImportExportTab) ──────────────────────

export interface ConfigImportTotals {
  settings?: number;
  profiles?: number;
  credentials?: number;
}

export interface ConfigImportError {
  section: string;
  row: number;
  message: string;
}

export interface ConfigImportResponse {
  totals?: ConfigImportTotals;
  errors?: ConfigImportError[];
}

export interface ConfigImportInput {
  data: string;
  dryRun: boolean;
}

/** GET /api/config/export as an explicit action (not cached). */
export function useExportConfig(options?: MutationHookOptions<{ data?: string }, void>) {
  return useMutation<{ data?: string }, unknown, void, unknown>({
    ...options,
    mutationFn: () => api.get<{ data?: string }>("/api/config/export"),
  });
}

/** POST /api/config/import; a real restore (not a dry run) refreshes every query. */
export function useImportConfig(options?: MutationHookOptions<ConfigImportResponse, ConfigImportInput>) {
  const queryClient = useQueryClient();
  return useMutation<ConfigImportResponse, unknown, ConfigImportInput, unknown>({
    ...options,
    mutationFn: (values) =>
      api.post<ConfigImportResponse>("/api/config/import", { data: values.data, dry_run: values.dryRun }),
    onSuccess: (data, variables, onMutateResult, context) => {
      if (!variables.dryRun) void queryClient.invalidateQueries();
      return options?.onSuccess?.(data, variables, onMutateResult, context);
    },
  });
}
