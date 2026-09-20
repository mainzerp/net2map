import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "./keys";

export interface LogEntry {
  ts?: string;
  level?: string;
  event?: string;
  [key: string]: unknown;
}

export interface LogsParams {
  limit?: number;
  level?: string;
  eventPrefix?: string;
  q?: string;
}

function buildLogsQuery(params: LogsParams): string {
  const limit = Math.max(1, Math.min(2000, Number(params.limit) || 300));
  const search = new URLSearchParams({ limit: String(limit) });
  if (params.level) search.set("level", params.level);
  if (params.eventPrefix) search.set("event_prefix", params.eventPrefix);
  if (params.q) search.set("q", params.q);
  return `/api/logs?${search.toString()}`;
}

export function useLogs(params: LogsParams = {}, refetchInterval: number | false = false) {
  return useQuery<LogEntry[]>({
    queryKey: queryKeys.logs(params as Record<string, unknown>),
    queryFn: async () => {
      const data: unknown = await api.get(buildLogsQuery(params));
      return Array.isArray(data) ? (data as LogEntry[]) : [];
    },
    refetchInterval,
    // Pause polling while the tab is hidden (visibility-aware refresh).
    refetchIntervalInBackground: false,
  });
}
