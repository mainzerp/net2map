import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { Credential } from "../../types";
import { queryKeys } from "./keys";

export function useCredentials() {
  return useQuery<Credential[]>({
    queryKey: queryKeys.credentials,
    queryFn: async () => {
      const data: unknown = await api.get("/api/credentials");
      return Array.isArray(data) ? (data as Credential[]) : [];
    },
  });
}
