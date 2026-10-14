/**
 * Tests for DeviceTable component.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "./test-utils";

// Mock the store
vi.mock("../store", () => {
  const store = () => vi.fn();
  store.getState = () => ({});
  return { default: store };
});

// Mock api module
const mockApiGet = vi.fn();
const mockApiPatch = vi.fn();
vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    invalidate: vi.fn(),
  },
  API: "",
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  normPort: (p: string | null) => (p || "").trim().toLowerCase(),
}));

import DeviceTable from "../components/DeviceTable";

const defaultProps = {
  title: "Network Devices",
  subtitle: "Managed switches",
  activeLabel: "Active",
  ignoredLabel: "Ignored",
  emptyMessage: "No devices found",
};

const devices = [
  {
    id: 1, sys_name: "core-sw-01", ip: "10.0.0.1", mac: "aa:bb:cc:00:00:01", vendor: "aruba_cx",
    ignored: false, ports: [], rack_id: null, class_id: null, model_id: null,
    ping_status: "online", location: "DC-1", last_seen: "2026-01-01T10:00:00Z",
  },
  {
    id: 2, sys_name: "access-sw-02", ip: "10.0.0.2", mac: "aa:bb:cc:00:00:02", vendor: "generic",
    ignored: false, ports: [], rack_id: null, class_id: null, model_id: null,
    ping_status: "offline", location: "", last_seen: "2026-01-01T09:00:00Z",
  },
];

function mockApiSuccess(deviceList: unknown[] = devices) {
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith("/api/devices")) return Promise.resolve(deviceList);
    if (path === "/api/racks") return Promise.resolve([]);
    if (path === "/api/switch-classes") return Promise.resolve([]);
    if (path === "/api/switch-models") return Promise.resolve([]);
    return Promise.resolve([]);
  });
}

describe("DeviceTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a Ping only badge for ping-only devices", async () => {
    mockApiSuccess([{ ...devices[0], ping_only: true }, devices[1]]);
    renderWithRouter(<DeviceTable {...defaultProps} />);
    await waitFor(() => expect(screen.getByText("core-sw-01")).toBeTruthy());
    expect(screen.getAllByText("Ping only")).toHaveLength(1);
  });

  it("renders device rows from API data", async () => {
    mockApiSuccess();

    renderWithRouter(<DeviceTable {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("core-sw-01")).toBeTruthy();
      expect(screen.getByText("access-sw-02")).toBeTruthy();
    });

    // Verify IPs render
    expect(screen.getByText("10.0.0.1")).toBeTruthy();
    expect(screen.getByText("10.0.0.2")).toBeTruthy();

    // New columns render
    expect(screen.getByText("DC-1")).toBeTruthy();
    expect(screen.getByText("online")).toBeTruthy();
    expect(screen.getByText("offline")).toBeTruthy();
  });

  it("shows empty message when no devices", async () => {
    mockApiSuccess([]);

    renderWithRouter(<DeviceTable {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("No devices found")).toBeTruthy();
    });
  });

  it("applies the status filter from the ?status=down deep link", async () => {
    mockApiSuccess();

    renderWithRouter(<DeviceTable {...defaultProps} />, { route: "/network?status=down" });

    await waitFor(() => {
      expect(screen.getByText("access-sw-02")).toBeTruthy();
    });

    // The online device is filtered out
    expect(screen.queryByText("core-sw-01")).toBeNull();
  });

  it("prefills the search from the ?q= query param", async () => {
    mockApiSuccess();

    renderWithRouter(<DeviceTable {...defaultProps} />, { route: "/network?q=core" });

    await waitFor(() => {
      expect(screen.getByText("core-sw-01")).toBeTruthy();
    });

    expect(screen.queryByText("access-sw-02")).toBeNull();
    expect(screen.getByDisplayValue("core")).toBeTruthy();
  });

  it("shows an error state with retry when the fetch fails", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path.startsWith("/api/devices")) return Promise.reject(new Error("boom"));
      return Promise.resolve([]);
    });

    renderWithRouter(<DeviceTable {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeTruthy();
    });
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  describe("edit modal", () => {
    const classifiedDevice = {
      ...devices[0],
      rack_id: null,
      class_id: 5,
      model_id: null,
    };

    function mockEditApi() {
      mockApiGet.mockImplementation((path: string) => {
        if (path.startsWith("/api/devices")) return Promise.resolve([classifiedDevice]);
        if (path === "/api/racks") return Promise.resolve([{ id: 7, label: "Rack-A", room: "" }]);
        if (path === "/api/switch-classes") {
          return Promise.resolve([
            { id: 5, label: "Core", color: "" },
            { id: 6, label: "Access", color: "" },
          ]);
        }
        if (path === "/api/switch-models") return Promise.resolve([]);
        return Promise.resolve([]);
      });
      mockApiPatch.mockResolvedValue({});
    }

    async function openEditModal() {
      renderWithRouter(<DeviceTable {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Core")).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const dialog = await screen.findByRole("dialog");
      const [rackSelect, classSelect] = within(dialog).getAllByRole("combobox");
      return { dialog, rackSelect, classSelect };
    }

    it("editing only the rack does not send class_id", async () => {
      mockEditApi();
      const { dialog, rackSelect } = await openEditModal();

      fireEvent.change(rackSelect, { target: { value: "7" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockApiPatch).toHaveBeenCalledTimes(1);
      });
      const [path, body] = mockApiPatch.mock.calls[0];
      expect(path).toBe("/api/topology/devices/1/meta");
      expect(body).toEqual({ rack_id: 7 });
      expect(body).not.toHaveProperty("class_id");
      expect(body).not.toHaveProperty("model_id");
    });

    it("changing the class sends class_id", async () => {
      mockEditApi();
      const { dialog, classSelect } = await openEditModal();

      fireEvent.change(classSelect, { target: { value: "6" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockApiPatch).toHaveBeenCalledTimes(1);
      });
      const [, body] = mockApiPatch.mock.calls[0];
      expect(body).toEqual({ class_id: 6 });
    });

    it("skips the request when nothing changed", async () => {
      mockEditApi();
      const { dialog } = await openEditModal();

      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(mockApiPatch).not.toHaveBeenCalled();
    });
  });
});
