/**
 * Tests for LogsPage client-side pagination.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

const mockApiGet = vi.fn();
vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    invalidate: vi.fn(),
  },
  API: "",
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
}));

import LogsPage from "../pages/LogsPage";

function makeLogs(n: number) {
  // The API returns oldest first; the page renders newest first.
  return Array.from({ length: n }, (_, i) => ({
    ts: `2024-01-01T00:00:${String(i).padStart(4, "0")}`,
    level: "INFO",
    event: `event.${i}`,
  }));
}

describe("LogsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders at most 100 rows per page and pages through all entries", async () => {
    mockApiGet.mockResolvedValue(makeLogs(250));
    renderWithRouter(<LogsPage />);

    await waitFor(() => expect(screen.getByText("Showing 1-100 of 250")).toBeTruthy());
    expect(screen.getByText("event.249")).toBeTruthy();
    expect(screen.queryByText("event.149")).toBeNull();
    expect(screen.getByText("Page 1 / 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Showing 101-200 of 250")).toBeTruthy();
    expect(screen.getByText("event.149")).toBeTruthy();
    expect(screen.queryByText("event.249")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Showing 201-250 of 250")).toBeTruthy();
    expect(screen.getByText("event.0")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("returns to the first page when a filter changes", async () => {
    mockApiGet.mockResolvedValue(makeLogs(250));
    renderWithRouter(<LogsPage />);

    await waitFor(() => expect(screen.getByText("Showing 1-100 of 250")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 / 3")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter by level"), { target: { value: "ERROR" } });
    await waitFor(() => expect(screen.getByText("Page 1 / 3")).toBeTruthy());
    expect(String(mockApiGet.mock.calls[mockApiGet.mock.calls.length - 1]?.[0])).toContain("level=ERROR");
  });
});
