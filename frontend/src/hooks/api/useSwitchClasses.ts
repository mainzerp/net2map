import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { SwitchClass } from "../../types";
import { queryKeys } from "./keys";

export function useSwitchClasses() {
  return useQuery<SwitchClass[]>({
    queryKey: queryKeys.switchClasses,
    queryFn: async () => {
      const data: unknown = await api.get("/api/switch-classes");
      return Array.isArray(data) ? (data as SwitchClass[]) : [];
    },
  });
}
