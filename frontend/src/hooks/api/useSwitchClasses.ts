import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { SwitchClass } from "../../types";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";
import { throwOnDetail } from "./payload";

export function useSwitchClasses() {
  return useQuery<SwitchClass[]>({
    queryKey: queryKeys.switchClasses,
    queryFn: async () => {
      const data: unknown = await api.get("/api/switch-classes");
      return Array.isArray(data) ? (data as SwitchClass[]) : [];
    },
  });
}

export interface SwitchClassSave {
  id: number | null;
  form: object;
}

export function useSaveSwitchClass(options?: MutationHookOptions<void, SwitchClassSave>) {
  return useApiMutation<void, SwitchClassSave>(
    async ({ id, form }) => {
      if (id) {
        await api.put(`/api/switch-classes/${id}`, form);
      } else {
        throwOnDetail(await api.post<{ detail?: unknown }>("/api/switch-classes", form));
      }
    },
    [queryKeys.switchClasses, queryKeys.topology],
    options,
  );
}

export function useDeleteSwitchClass(options?: MutationHookOptions<void, number>) {
  return useApiMutation<void, number>(
    (id) => api.del(`/api/switch-classes/${id}`),
    [queryKeys.switchClasses, queryKeys.topology, queryKeys.devices],
    options,
  );
}
