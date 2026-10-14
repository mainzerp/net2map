import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { SnmpProfile } from "../../types";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";
import { stripEmptySecrets } from "./payload";

export function useSnmpProfiles() {
  return useQuery<SnmpProfile[]>({
    queryKey: queryKeys.snmpProfiles,
    queryFn: async () => {
      const data: unknown = await api.get("/api/snmp-profiles");
      return Array.isArray(data) ? (data as SnmpProfile[]) : [];
    },
  });
}

const SNMP_PROFILE_KEYS = [queryKeys.snmpProfiles, queryKeys.credentials];

export interface SnmpProfileSave {
  id: number | null;
  form: object;
}

/** Create (id null) or update an SNMP profile; empty secrets are kept on edit. */
export function useSaveSnmpProfile(options?: MutationHookOptions<void, SnmpProfileSave>) {
  return useApiMutation<void, SnmpProfileSave>(
    async ({ id, form }) => {
      if (id) {
        await api.put(`/api/snmp-profiles/${id}`, stripEmptySecrets(form));
      } else {
        await api.post("/api/snmp-profiles", form);
      }
    },
    SNMP_PROFILE_KEYS,
    options,
  );
}

export function useDeleteSnmpProfile(options?: MutationHookOptions<void, number>) {
  return useApiMutation<void, number>((id) => api.del(`/api/snmp-profiles/${id}`), SNMP_PROFILE_KEYS, options);
}
