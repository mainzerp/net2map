/**
 * useScanJob: scan job polling stops on a final status, gives up after
 * consecutive failed GETs, and never overlaps requests.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "./test-utils";

const mockApiGet = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    invalidate: vi.fn(),
  },
  API: "",
  apiUrl: (path: string) => path,
}));

import { useScanJob } from "../hooks/api";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>;
}

describe("useScanJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("polls until the job reaches a final status", async () => {
    mockApiGet
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "finished", result: { found: 2 } });
    const { result } = renderHook(() => useScanJob<{ found: number }>("job-1", { intervalMs: 10 }), { wrapper });

    await waitFor(() => expect(result.current.finished).toBe(true));
    expect(result.current.job?.result).toEqual({ found: 2 });
    expect(mockApiGet).toHaveBeenCalledWith("/api/scan/jobs/job-1");
    const calls = mockApiGet.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(mockApiGet.mock.calls.length).toBe(calls);
  });

  it("gives up after the consecutive error cap and surfaces the error", async () => {
    mockApiGet.mockRejectedValue(new Error("HTTP 500: boom"));
    const { result } = renderHook(() => useScanJob("job-2", { intervalMs: 10, maxErrors: 3 }), { wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect((result.current.error as Error).message).toBe("HTTP 500: boom");
    expect(mockApiGet).toHaveBeenCalledTimes(3);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockApiGet).toHaveBeenCalledTimes(3);
  });

  it("does not start a new request while one is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    mockApiGet.mockImplementation(() => new Promise((r) => { resolve = r; }));
    renderHook(() => useScanJob("job-3", { intervalMs: 5 }), { wrapper });

    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 40));
    expect(mockApiGet).toHaveBeenCalledTimes(1);
    resolve({ status: "finished" });
  });

  it("times out after the maximum duration", async () => {
    mockApiGet.mockResolvedValue({ status: "running" });
    const { result } = renderHook(() => useScanJob("job-4", { intervalMs: 10, maxDurationMs: 40 }), { wrapper });

    await waitFor(() => expect(result.current.timedOut).toBe(true));
    const calls = mockApiGet.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(mockApiGet.mock.calls.length).toBe(calls);
  });
});
