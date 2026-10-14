import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { TopologyData } from "../../types";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";

export interface UseTopologyOptions {
  /** Polling interval in ms; the ETag in api.get keeps 304 responses cheap. */
  refetchInterval?: number | false;
}

export function useTopology({ refetchInterval }: UseTopologyOptions = {}) {
  return useQuery<TopologyData>({
    queryKey: queryKeys.topology,
    queryFn: () => api.get<TopologyData>("/api/topology"),
    refetchInterval,
  });
}

export interface MapPositionUpdate {
  id: number | string;
  x: number;
  y: number;
}

// Map position writes: the canvas already shows the dragged position, so no
// query is invalidated (a refetch would only echo it back).
export function useUpdateDevicePosition(options?: MutationHookOptions<unknown, MapPositionUpdate>) {
  return useApiMutation<unknown, MapPositionUpdate>(
    ({ id, x, y }) => api.patch(`/api/topology/devices/${id}/position`, { map_x: x, map_y: y }),
    [],
    options,
  );
}

export function useUpdateRackPosition(options?: MutationHookOptions<unknown, MapPositionUpdate>) {
  return useApiMutation<unknown, MapPositionUpdate>(
    ({ id, x, y }) => api.patch(`/api/topology/racks/${id}/position`, { map_x: x, map_y: y }),
    [],
    options,
  );
}
