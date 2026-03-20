/**
 * Shared test utilities: render helpers, store mocks, and API mocks.
 */
import React, { type ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { ToastProvider } from "../components/ToastProvider";

/**
 * Render a component wrapped in MemoryRouter and ToastProvider for tests.
 */
export function renderWithRouter(
  ui: ReactElement,
  { route = "/", ...options }: RenderOptions & { route?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>,
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
