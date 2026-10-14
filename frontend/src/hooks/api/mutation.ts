import { useMutation, useQueryClient, type QueryKey, type UseMutationOptions } from "@tanstack/react-query";

// Per-component mutation options (state updates, toasts); the hook owns the
// mutationFn and the cache invalidation.
export type MutationHookOptions<TData, TVariables> = Omit<
  UseMutationOptions<TData, unknown, TVariables, unknown>,
  "mutationFn"
>;

/**
 * Shared mutation wrapper for the API hooks: invalidates the given query keys
 * on success, then runs the caller's own onSuccess.
 */
export function useApiMutation<TData, TVariables>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  invalidateKeys: QueryKey[] | ((data: TData, variables: TVariables) => QueryKey[]),
  options?: MutationHookOptions<TData, TVariables>,
) {
  const queryClient = useQueryClient();
  return useMutation<TData, unknown, TVariables, unknown>({
    ...options,
    mutationFn,
    onSuccess: (data, variables, onMutateResult, context) => {
      const keys = typeof invalidateKeys === "function" ? invalidateKeys(data, variables) : invalidateKeys;
      keys.forEach((queryKey) => {
        void queryClient.invalidateQueries({ queryKey });
      });
      return options?.onSuccess?.(data, variables, onMutateResult, context);
    },
  });
}
