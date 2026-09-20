import { useCallback } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { queryKeys } from "./keys";

// Invalidation helper: returns stable functions to invalidate API queries
// after mutations so dependent views refetch.
export function useInvalidateApi() {
  const queryClient = useQueryClient();

  const invalidate = useCallback(
    (...keys: QueryKey[]) => {
      keys.forEach((key) => {
        void queryClient.invalidateQueries({ queryKey: key });
      });
    },
    [queryClient],
  );

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);

  const invalidateTopology = useCallback(() => {
    invalidate(queryKeys.topology, queryKeys.stats, queryKeys.devices, queryKeys.racks);
  }, [invalidate]);

  return { invalidate, invalidateAll, invalidateTopology };
}
