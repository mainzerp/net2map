import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { ScanRun } from "../../types";
import { queryKeys } from "../../hooks/api/keys";

// Fetches the most recent scan run for the dashboard hero card.
export function useLastScanRun() {
  return useQuery<ScanRun[]>({
    queryKey: [...queryKeys.scanRuns, "last"],
    queryFn: async () => {
      const data: unknown = await api.get("/api/scan-runs?limit=1");
      return Array.isArray(data) ? (data as ScanRun[]) : [];
    },
  });
}
