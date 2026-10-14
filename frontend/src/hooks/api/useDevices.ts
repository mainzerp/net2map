import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { TopologyNode } from "../../types";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";

export function useDevices() {
  return useQuery<TopologyNode[]>({
    queryKey: queryKeys.devices,
    queryFn: () => api.get<TopologyNode[]>("/api/devices"),
  });
}

// Device metadata writes (rack/class/model/floor assignment, ignored flag).
// Assignments show up in the topology, device, rack, stats and credential
// views, so all of them are refreshed.
const DEVICE_META_KEYS = [
  queryKeys.topology,
  queryKeys.stats,
  queryKeys.devices,
  queryKeys.racks,
  queryKeys.credentials,
];

export interface DeviceMetaUpdate {
  id: number | string;
  patch: Record<string, unknown>;
}

export function useUpdateDeviceMeta(options?: MutationHookOptions<unknown, DeviceMetaUpdate>) {
  return useApiMutation<unknown, DeviceMetaUpdate>(
    ({ id, patch }) => api.patch(`/api/topology/devices/${id}/meta`, patch),
    DEVICE_META_KEYS,
    options,
  );
}

/** PATCH /api/topology/devices/bulk-meta with { device_ids, ...fields }. */
export function useBulkUpdateDeviceMeta(options?: MutationHookOptions<unknown, Record<string, unknown>>) {
  return useApiMutation<unknown, Record<string, unknown>>(
    (body) => api.patch("/api/topology/devices/bulk-meta", body),
    DEVICE_META_KEYS,
    options,
  );
}
