import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "./keys";

export interface Stats {
  device_count: number;
  port_count: number;
  port_up_count: number;
  rack_count: number;
  [key: string]: unknown;
}

export function useStats() {
  return useQuery<Stats>({
    queryKey: queryKeys.stats,
    queryFn: () => api.get<Stats>("/api/stats"),
  });
}
