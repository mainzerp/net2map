import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { RackInfo } from "../../types";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";
import { throwOnDetail } from "./payload";

export function useRacks() {
  return useQuery<RackInfo[]>({
    queryKey: queryKeys.racks,
    queryFn: () => api.get<RackInfo[]>("/api/racks"),
  });
}

const RACK_KEYS = [queryKeys.racks, queryKeys.devices, queryKeys.topology, queryKeys.stats];

export interface RackSave {
  id: number | null;
  payload: object;
}

/** Create (id null) or update (PUT) a rack. */
export function useSaveRack(options?: MutationHookOptions<void, RackSave>) {
  return useApiMutation<void, RackSave>(
    async ({ id, payload }) => {
      if (id) {
        await api.put(`/api/racks/${id}`, payload);
      } else {
        throwOnDetail(await api.post<{ detail?: unknown }>("/api/racks", payload));
      }
    },
    RACK_KEYS,
    options,
  );
}

export function useDeleteRack(options?: MutationHookOptions<void, number>) {
  return useApiMutation<void, number>((id) => api.del(`/api/racks/${id}`), RACK_KEYS, options);
}
