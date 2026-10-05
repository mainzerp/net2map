import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { TopologyData } from "../../types";
import { queryKeys } from "./keys";

export function useTopology() {
  return useQuery<TopologyData>({
    queryKey: queryKeys.topology,
    queryFn: () => api.get<TopologyData>("/api/topology"),
  });
}
