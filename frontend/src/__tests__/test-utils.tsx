/**
 * Shared test utilities: render helpers, store mocks, and API mocks.
 */
import React, { type ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { ToastProvider } from "../components/ToastProvider";
import { MotionProvider } from "../theme/MotionProvider";

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
 * Render a component wrapped in QueryClientProvider, MemoryRouter,
 * MotionProvider and ToastProvider for tests (same order as main.tsx).
 */
export function renderWithRouter(
  ui: ReactElement,
  { route = "/", queryClient, ...options }: RenderOptions & { route?: string; queryClient?: QueryClient } = {},
) {
  const client = queryClient ?? createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <MotionProvider>
          <ToastProvider>{ui}</ToastProvider>
        </MotionProvider>
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
 * Replace the global localStorage with an in-memory Map-backed stub (the
 * runtime's built-in storage is not usable in the test environment).
 * Pair with `vi.unstubAllGlobals()` in afterEach.
 */
export function stubMemoryStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  });
  return values;
}

/**
 * Helper to wait for async component updates.
 */
export { waitFor, screen, act } from "@testing-library/react";
