import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { Credential } from "../../types";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";
import { stripEmptySecrets } from "./payload";

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

const CREDENTIAL_KEYS = [queryKeys.credentials, queryKeys.devices, queryKeys.topology];

export interface CredentialSave {
  id: number | null;
  form: object;
}

/** Create (id null) or update a credential; empty secrets are kept on edit. */
export function useSaveCredential(options?: MutationHookOptions<void, CredentialSave>) {
  return useApiMutation<void, CredentialSave>(
    async ({ id, form }) => {
      if (id) {
        await api.put(`/api/credentials/${id}`, stripEmptySecrets(form));
      } else {
        await api.post("/api/credentials", form);
      }
    },
    CREDENTIAL_KEYS,
    options,
  );
}

export function useDeleteCredential(options?: MutationHookOptions<void, number>) {
  return useApiMutation<void, number>((id) => api.del(`/api/credentials/${id}`), CREDENTIAL_KEYS, options);
}
