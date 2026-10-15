/**
 * Scan range editor (DiscoveryRanges), the enabled-range logic of the dry
 * run panel and the new probe fields of the scan engine settings.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "./test-utils";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();
const mockApiPatch = vi.fn();
const mockApiDel = vi.fn();
const mockUser = { current: { username: "admin", role: "admin" } as { username: string; role: string } | null };

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: (...args: unknown[]) => mockApiPut(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    del: (...args: unknown[]) => mockApiDel(...args),
    invalidate: vi.fn(),
  },
  getStoredUser: () => mockUser.current,
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  API: "",
}));

import DiscoveryRanges, { formatInterval, parseIntervalSec } from "../components/settings/scan/DiscoveryRanges";
import DryRunPanel from "../components/settings/scan/DryRunPanel";
import ScanEngineConfig from "../components/settings/scan/ScanEngineConfig";
import type { ScanRange } from "../types";

const RANGES: ScanRange[] = [
  {
    id: 1,
    cidr: "10.0.0.0/24",
    label: "Core",
    enabled: true,
    interval_sec: null,
    profile_ids: [],
    last_scan_at: "2024-05-01T10:00:00",
    next_scan_at: "2024-05-01T10:30:00",
    host_count: 254,
  },
  {
    id: 2,
    cidr: "10.0.1.0/24",
    label: "Lab",
    enabled: false,
    interval_sec: 3600,
    profile_ids: [5],
    last_scan_at: null,
    next_scan_at: null,
    host_count: 254,
  },
];

const PROFILES = [
  { id: 5, label: "Public v2c" },
  { id: 6, label: "Secure v3" },
];

function mockGets(ranges: ScanRange[] = RANGES) {
  mockApiGet.mockImplementation((path: string) => {
    if (path === "/api/scan-ranges") return Promise.resolve(ranges);
    if (path === "/api/snmp-profiles") return Promise.resolve(PROFILES);
    if (path.startsWith("/api/scan/jobs/")) return Promise.resolve({ status: "finished" });
    if (path === "/api/scan-settings") {
      return Promise.resolve({ max_workers: 4, snmp_timeout: 3, snmp_retries: 1, snmp_bulk_size: 25, probe_workers: 32, probe_skip_hours: 12 });
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.current = { username: "admin", role: "admin" };
  mockGets();
  mockApiPost.mockResolvedValue({ job_id: "job-1", status: "queued" });
  mockApiPatch.mockResolvedValue({});
  mockApiPut.mockResolvedValue({});
  mockApiDel.mockResolvedValue(undefined);
});

describe("scan range helpers", () => {
  it("parses the interval field to seconds", () => {
    expect(parseIntervalSec("", "min")).toEqual({ value: null, error: "" });
    expect(parseIntervalSec("15", "min")).toEqual({ value: 900, error: "" });
    expect(parseIntervalSec("90", "sec")).toEqual({ value: 90, error: "" });
    expect(parseIntervalSec("30", "sec").error).toMatch(/between/);
    expect(parseIntervalSec("abc", "sec").error).toMatch(/positive/);
  });

  it("formats intervals", () => {
    expect(formatInterval(null)).toBe("default");
    expect(formatInterval(3600)).toBe("1 h");
    expect(formatInterval(900)).toBe("15 min");
    expect(formatInterval(90)).toBe("90 s");
  });
});

describe("DiscoveryRanges", () => {
  it("renders the range list with interval, profiles and host count", async () => {
    renderWithRouter(<DiscoveryRanges />);
    const core = await screen.findByTestId("scan-range-1");
    expect(within(core).getByText("10.0.0.0/24")).toBeTruthy();
    expect(within(core).getByText("Core")).toBeTruthy();
    expect(within(core).getByText("default")).toBeTruthy();
    expect(within(core).getByText("all")).toBeTruthy();
    expect(within(core).getByText("254")).toBeTruthy();
    const lab = screen.getByTestId("scan-range-2");
    expect(within(lab).getByText("1 h")).toBeTruthy();
    await waitFor(() => expect(within(lab).getByText("Public v2c")).toBeTruthy());
    expect((within(lab).getByLabelText("Enable 10.0.1.0/24") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/2 range\(s\), 1 enabled/)).toBeTruthy();
  });

  it("creates a range with profile_ids and a null interval when empty", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ...RANGES[0], id: 3, cidr: "192.168.1.0/24" });
    renderWithRouter(<DiscoveryRanges />);
    const form = await screen.findByTestId("scan-range-add");
    fireEvent.change(within(form).getByLabelText("CIDR"), { target: { value: " 192.168.1.0/24 " } });
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Office" } });
    await waitFor(() => expect(within(form).getByLabelText("Secure v3")).toBeTruthy());
    await user.click(within(form).getByLabelText("Secure v3"));
    await user.click(within(form).getByRole("button", { name: "Add range" }));
    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith("/api/scan-ranges", {
        cidr: "192.168.1.0/24",
        label: "Office",
        enabled: true,
        interval_sec: null,
        profile_ids: [6],
      });
    });
  });

  it("sends the interval in seconds when minutes are entered", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue(RANGES[0]);
    renderWithRouter(<DiscoveryRanges />);
    const form = await screen.findByTestId("scan-range-add");
    fireEvent.change(within(form).getByLabelText("CIDR"), { target: { value: "172.16.0.0/16" } });
    fireEvent.change(within(form).getByLabelText("Interval"), { target: { value: "15" } });
    await user.click(within(form).getByRole("button", { name: "Add range" }));
    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        "/api/scan-ranges",
        expect.objectContaining({ cidr: "172.16.0.0/16", interval_sec: 900, profile_ids: [] }),
      );
    });
  });

  it("rejects an out-of-range interval without calling the API", async () => {
    const user = userEvent.setup();
    renderWithRouter(<DiscoveryRanges />);
    const form = await screen.findByTestId("scan-range-add");
    fireEvent.change(within(form).getByLabelText("CIDR"), { target: { value: "172.16.0.0/16" } });
    fireEvent.change(within(form).getByLabelText("Interval"), { target: { value: "30" } });
    fireEvent.change(within(form).getByLabelText("Interval unit"), { target: { value: "sec" } });
    await user.click(within(form).getByRole("button", { name: "Add range" }));
    expect(within(form).getByText(/between 1 minute and 7 days/)).toBeTruthy();
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("toggles enabled via PATCH", async () => {
    const user = userEvent.setup();
    renderWithRouter(<DiscoveryRanges />);
    await user.click(await screen.findByLabelText("Enable 10.0.0.0/24"));
    await waitFor(() => {
      expect(mockApiPatch).toHaveBeenCalledWith("/api/scan-ranges/1", { enabled: false });
    });
  });

  it("edits a row inline and resets the interval to default", async () => {
    const user = userEvent.setup();
    renderWithRouter(<DiscoveryRanges />);
    await user.click(await screen.findByRole("button", { name: "Edit 10.0.1.0/24" }));
    const row = screen.getByTestId("scan-range-2");
    const interval = within(row).getByLabelText("Interval") as HTMLInputElement;
    expect(interval.value).toBe("60");
    fireEvent.change(interval, { target: { value: "" } });
    await user.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(mockApiPatch).toHaveBeenCalledWith(
        "/api/scan-ranges/2",
        expect.objectContaining({ cidr: "10.0.1.0/24", interval_sec: null, profile_ids: [5], enabled: false }),
      );
    });
  });

  it("deletes a range after confirmation", async () => {
    const user = userEvent.setup();
    renderWithRouter(<DiscoveryRanges />);
    await user.click(await screen.findByRole("button", { name: "Delete 10.0.0.0/24" }));
    const dialog = await screen.findByRole("dialog");
    expect(mockApiDel).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockApiDel).toHaveBeenCalledWith("/api/scan-ranges/1"));
  });

  it("starts a scan for one range and for all ranges", async () => {
    const user = userEvent.setup();
    renderWithRouter(<DiscoveryRanges />);
    await user.click(await screen.findByRole("button", { name: "Scan 10.0.0.0/24 now" }));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/scan-ranges/1/scan", {}));
    expect(await screen.findByText(/job job-1/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Scan all ranges now" }));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/scan-ranges/scan", {}));
  });

  it("is read-only for viewers", async () => {
    mockUser.current = { username: "view", role: "viewer" };
    renderWithRouter(<DiscoveryRanges />);
    const row = await screen.findByTestId("scan-range-1");
    expect((within(row).getByLabelText("Enable 10.0.0.0/24") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Scan 10.0.0.0\/24 now/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scan all ranges now" })).toBeNull();
    expect(screen.queryByTestId("scan-range-add")).toBeNull();
  });
});

describe("DryRunPanel", () => {
  it("is disabled when no range is enabled", async () => {
    mockGets([{ ...RANGES[1] }]);
    renderWithRouter(<DryRunPanel />);
    expect(await screen.findByText(/Enable at least one range/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Dry Run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is disabled without ranges", async () => {
    mockGets([]);
    renderWithRouter(<DryRunPanel />);
    expect(await screen.findByText(/Configure ranges above/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Dry Run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is enabled with an enabled range and starts a dry run job", async () => {
    const user = userEvent.setup();
    renderWithRouter(<DryRunPanel />);
    expect(await screen.findByText(/Probes 1 enabled range/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Dry Run" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/scan/dry-run/jobs", {}));
  });
});

describe("ScanEngineConfig probe settings", () => {
  it("hydrates and saves probe_workers and probe_skip_hours with clamping", async () => {
    const user = userEvent.setup();
    renderWithRouter(<ScanEngineConfig />);
    const workers = (await screen.findByLabelText("Parallel discovery probes")) as HTMLInputElement;
    const skip = screen.getByLabelText("Ping-only re-probe skip hours") as HTMLInputElement;
    await waitFor(() => expect(workers.value).toBe("32"));
    expect(skip.value).toBe("12");
    fireEvent.change(workers, { target: { value: "500" } });
    fireEvent.change(skip, { target: { value: "0" } });
    await user.click(screen.getByRole("button", { name: "Save Scan Settings" }));
    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith(
        "/api/scan-settings",
        expect.objectContaining({ probe_workers: 256, probe_skip_hours: 0 }),
      );
    });
  });
});
