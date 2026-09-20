import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { TopologyNode } from "../../types";
import { queryKeys } from "./keys";

export function useDevices() {
  return useQuery<TopologyNode[]>({
    queryKey: queryKeys.devices,
    queryFn: () => api.get("/api/devices"),
  });
}
