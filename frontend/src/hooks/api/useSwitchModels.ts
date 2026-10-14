import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { SwitchModel } from "../../types";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";
import { throwOnDetail } from "./payload";

export function useSwitchModels() {
  return useQuery<SwitchModel[]>({
    queryKey: queryKeys.switchModels,
    queryFn: async () => {
      const data: unknown = await api.get("/api/switch-models");
      return Array.isArray(data) ? (data as SwitchModel[]) : [];
    },
  });
}

const SWITCH_MODEL_KEYS = [queryKeys.switchModels, queryKeys.topology, queryKeys.devices];

export interface SwitchModelSave {
  id: number | null;
  payload: object;
}

export function useSaveSwitchModel(options?: MutationHookOptions<void, SwitchModelSave>) {
  return useApiMutation<void, SwitchModelSave>(
    async ({ id, payload }) => {
      if (id) {
        await api.put(`/api/switch-models/${id}`, payload);
      } else {
        throwOnDetail(await api.post<{ detail?: unknown }>("/api/switch-models", payload));
      }
    },
    SWITCH_MODEL_KEYS,
    options,
  );
}

export function useDeleteSwitchModel(options?: MutationHookOptions<void, number>) {
  return useApiMutation<void, number>((id) => api.del(`/api/switch-models/${id}`), SWITCH_MODEL_KEYS, options);
}
