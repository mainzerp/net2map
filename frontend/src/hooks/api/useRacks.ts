import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { RackInfo } from "../../types";
import { queryKeys } from "./keys";

export function useRacks() {
  return useQuery<RackInfo[]>({
    queryKey: queryKeys.racks,
    queryFn: () => api.get<RackInfo[]>("/api/racks"),
  });
}
