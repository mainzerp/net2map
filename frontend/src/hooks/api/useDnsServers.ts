import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "./keys";

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
