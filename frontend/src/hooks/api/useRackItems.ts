import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import type { RackItem, RackItemInput } from "../../types";
import { queryKeys } from "./keys";

// ── Rack item data hooks ─────────────────────────────────────────────────────
// Manually maintained rack placeholders: GET/POST /api/racks/{id}/items,
// PATCH/DELETE /api/rack-items/{id}. Every write invalidates the rack's item
// list and the topology (the backend bumps the topology version).

export function useRackItems(rackId: number | null | undefined) {
  return useQuery<RackItem[]>({
    queryKey: queryKeys.rackItems(rackId ?? undefined),
    enabled: rackId != null,
    queryFn: async () => {
      const data: unknown = await api.get(`/api/racks/${rackId}/items`);
      return Array.isArray(data) ? (data as RackItem[]) : [];
    },
  });
}

function useInvalidateRackItems(rackId: number) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.rackItems(rackId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.topology });
  };
}

export function useCreateRackItem(rackId: number) {
  const onSettled = useInvalidateRackItems(rackId);
  return useMutation({
    mutationFn: (body: RackItemInput) => api.post<RackItem>(`/api/racks/${rackId}/items`, body),
    onSettled,
  });
}

type RackItemPatch = Partial<RackItemInput> & { id: number };

interface RackItemsSnapshot {
  previous: RackItem[] | undefined;
}

// optimistic: patch the cached item list immediately (drag moves in the rack
// elevation) and restore the snapshot on error; callers report the error
// themselves (toast or inline message) via mutate's onError.
export function useUpdateRackItem(rackId: number, { optimistic = false }: { optimistic?: boolean } = {}) {
  const queryClient = useQueryClient();
  const onSettled = useInvalidateRackItems(rackId);
  const key = queryKeys.rackItems(rackId);
  return useMutation<RackItem, unknown, RackItemPatch, RackItemsSnapshot>({
    mutationFn: ({ id, ...body }: RackItemPatch) => api.patch<RackItem>(`/api/rack-items/${id}`, body),
    onMutate: async ({ id, ...body }) => {
      if (!optimistic) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<RackItem[]>(key);
      queryClient.setQueryData<RackItem[]>(key, (old) =>
        old?.map((item) => (item.id === id ? { ...item, ...body } : item)),
      );
      return { previous };
    },
    onError: (_ex, _vars, context) => {
      if (optimistic && context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled,
  });
}

export function useDeleteRackItem(rackId: number) {
  const onSettled = useInvalidateRackItems(rackId);
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/rack-items/${id}`),
    onSettled,
  });
}
