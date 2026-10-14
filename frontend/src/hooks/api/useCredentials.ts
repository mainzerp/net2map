import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { Credential } from "../../types";
import { queryKeys } from "./keys";

export function useCredentials({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<Credential[]>({
    queryKey: queryKeys.credentials,
    enabled,
    queryFn: async () => {
      const data: unknown = await api.get("/api/credentials");
      return Array.isArray(data) ? (data as Credential[]) : [];
    },
  });
}
