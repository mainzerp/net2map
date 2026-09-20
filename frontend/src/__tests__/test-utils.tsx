/**
 * Shared test utilities: render helpers, store mocks, and API mocks.
 */
import React, { type ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { ToastProvider } from "../components/ToastProvider";

/**
 * Fresh React Query client per render: no retries, no cache reuse across tests.
 */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  });
}

/**
 * Render a component wrapped in QueryClientProvider, MemoryRouter and
 * ToastProvider for tests.
 */
export function renderWithRouter(
  ui: ReactElement,
  { route = "/", queryClient, ...options }: RenderOptions & { route?: string; queryClient?: QueryClient } = {},
) {
  const client = queryClient ?? createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
    options,
  );
}

/**
 * Create a mock for the `api` object from ../api.ts.
 * Returns an object with vi.fn() stubs for get/post/put/patch/delete/invalidate.
 */
export function createApiMock() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    invalidate: vi.fn(),
  };
}

/**
 * Helper to wait for async component updates.
 */
export { waitFor, screen, act } from "@testing-library/react";
