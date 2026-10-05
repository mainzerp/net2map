import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { Endpoint } from "../../types";
import { queryKeys } from "./keys";

export function useEndpoints() {
  return useQuery<Endpoint[]>({
    queryKey: queryKeys.endpoints,
    queryFn: () => api.get<Endpoint[]>("/api/endpoints"),
  });
}
