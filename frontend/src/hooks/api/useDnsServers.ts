import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";
import type { DnsTestResponse } from "../../types";

// ── DNS resolver settings (DnsTab) ───────────────────────────────────────────

export function useDnsServers() {
  return useQuery<string[]>({
    queryKey: queryKeys.dnsSettings,
    queryFn: async () => {
      const data: unknown = await api.get("/api/dns-settings");
      const servers = (data as { servers?: unknown } | null)?.servers;
      return Array.isArray(servers) ? (servers as string[]) : [];
    },
  });
}

/** PUT the server list; resolves with the normalized list the backend stored. */
export function useUpdateDnsServers(options?: MutationHookOptions<string[], string[]>) {
  return useApiMutation<string[], string[]>(
    async (list) => {
      const result: { servers?: string[] } = await api.put("/api/dns-settings", { servers: list });
      return Array.isArray(result?.servers) ? result.servers : list;
    },
    [queryKeys.dnsSettings],
    options,
  );
}

/** Reverse-resolve one IP with the configured servers and the system resolver (no cache). */
export function useTestDns(options?: MutationHookOptions<DnsTestResponse, string>) {
  return useApiMutation<DnsTestResponse, string>(
    async (ip) => (await api.post("/api/dns-settings/test", { ip })) as DnsTestResponse,
    [],
    options,
  );
}
