import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { SnmpProfile } from "../../types";
import { queryKeys } from "./keys";

export function useSnmpProfiles() {
  return useQuery<SnmpProfile[]>({
    queryKey: queryKeys.snmpProfiles,
    queryFn: async () => {
      const data: unknown = await api.get("/api/snmp-profiles");
      return Array.isArray(data) ? (data as SnmpProfile[]) : [];
    },
  });
}
