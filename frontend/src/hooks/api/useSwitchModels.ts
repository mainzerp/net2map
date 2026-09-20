import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { SwitchModel } from "../../types";
import { queryKeys } from "./keys";

export function useSwitchModels() {
  return useQuery<SwitchModel[]>({
    queryKey: queryKeys.switchModels,
    queryFn: async () => {
      const data: unknown = await api.get("/api/switch-models");
      return Array.isArray(data) ? (data as SwitchModel[]) : [];
    },
  });
}
