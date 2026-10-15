/**
 * Network scan card: "Run Scan" starts a full scan, "Run Scan + Ranges" the
 * combined range + full job; the result panel shows the range counts and the
 * history shows the scan type.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "./test-utils";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    invalidate: vi.fn(),
  },
  getStoredUser: () => ({ username: "admin", role: "admin" }),
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  API: "",
}));

import ScanRunHistory from "../components/settings/scan/ScanRunHistory";

const HISTORY = [
  {
    id: 2, status: "finished", scan_type: "ranges", found: 2, links: 0, total_duration_ms: 4000,
    max_workers: 64, error_count: 0, new_devices: [], removed_devices: [], new_links: [], removed_links: [],
    created_at: "2026-10-15T12:00:00", switch_metrics: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith("/api/scan-runs")) return Promise.resolve(HISTORY);
    if (path.startsWith("/api/scan/jobs/")) {
      return Promise.resolve({
        status: "finished",
        result: { scanned: 48, found: 50, links: 227, errors: [], status: "finished", ranges_scanned: 254, ranges_found: 2 },
      });
    }
    return Promise.resolve([]);
  });
  mockApiPost.mockResolvedValue({ job_id: "job-1", status: "queued" });
});

describe("ScanRunHistory", () => {
  it("starts a plain full scan with Run Scan", async () => {
    const user = userEvent.setup();
    renderWithRouter(<ScanRunHistory />);
    await user.click(screen.getByRole("button", { name: "Run Scan" }));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/scan/jobs", {}));
  });

  it("starts the combined job with Run Scan + Ranges and shows the range counts", async () => {
    const user = userEvent.setup();
    renderWithRouter(<ScanRunHistory />);
    await user.click(screen.getByRole("button", { name: "Run Scan + Ranges" }));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/scan/jobs?include_ranges=true", {}));
    expect(await screen.findByText("RANGES")).toBeTruthy();
    expect(screen.getByText("2 / 254")).toBeTruthy();
  });

  it("shows the scan type in the history", async () => {
    renderWithRouter(<ScanRunHistory />);
    expect(await screen.findByText("ranges")).toBeTruthy();
  });
});
