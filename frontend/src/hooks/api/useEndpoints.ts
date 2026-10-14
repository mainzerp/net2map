import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { Endpoint } from "../../types";
import { queryKeys } from "./keys";
import { useApiMutation, type MutationHookOptions } from "./mutation";

export function useEndpoints() {
  return useQuery<Endpoint[]>({
    queryKey: queryKeys.endpoints,
    queryFn: () => api.get<Endpoint[]>("/api/endpoints"),
  });
}

export interface EndpointUpdate {
  id: number;
  patch: Record<string, unknown>;
}

export function useUpdateEndpoint(options?: MutationHookOptions<unknown, EndpointUpdate>) {
  return useApiMutation<unknown, EndpointUpdate>(
    ({ id, patch }) => api.patch(`/api/endpoints/${id}`, patch),
    [queryKeys.endpoints],
    options,
  );
}

/** PATCH /api/endpoints/bulk with { endpoint_ids, ...fields }. */
export function useBulkUpdateEndpoints(options?: MutationHookOptions<unknown, Record<string, unknown>>) {
  return useApiMutation<unknown, Record<string, unknown>>(
    (body) => api.patch("/api/endpoints/bulk", body),
    [queryKeys.endpoints],
    options,
  );
}
