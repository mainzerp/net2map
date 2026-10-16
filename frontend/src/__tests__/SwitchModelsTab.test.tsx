/**
 * Hardware models tab: layout preview and matching-device suggestions.
 */
import { type ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockApiGet = vi.fn();
const mockApiPatch = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    del: vi.fn(),
    invalidate: vi.fn(),
  },
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  API: "",
}));

import ModelsTabContent from "../components/settings/SwitchModelsTab";

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function device(id: number, name: string, model: string, modelId: number | null = null) {
  return {
    id, ip: `10.0.0.${id}`, hostname: name, sys_name: name, vendor: "Aruba", model,
    rack_id: null, class_id: null, model_id: modelId, ignored: false,
  };
}

describe("SwitchModelsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/switch-models") {
        return Promise.resolve([{ id: 5, name: "6300M", ports_per_row: 24, total_ports: null }]);
      }
      if (path === "/api/devices") {
        return Promise.resolve([
          device(1, "sw-a", "Aruba 6300M 48G"),
          device(2, "sw-b", "JL762A 6300M"),
          device(3, "sw-c", "6200F"),
          device(4, "sw-d", "6300M", 5),
        ]);
      }
      return Promise.resolve([]);
    });
    mockApiPatch.mockResolvedValue({});
  });

  it("renders the port layout preview in the dialog", async () => {
    renderWithQuery(<ModelsTabContent newEntryTrigger={1} />);
    expect(await screen.findByText("New hardware model")).toBeTruthy();
    expect(screen.getByText("48 ports per row, all visible")).toBeTruthy();
    expect(screen.getByText(/so 24 columns show 48 ports per row/)).toBeTruthy();
    expect(screen.getByText("Ports above this number are hidden (e.g. uplink or virtual ports).")).toBeTruthy();
  });

  it("suggests unassigned devices that report a matching model and assigns them all", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ModelsTabContent newEntryTrigger={0} />);
    expect(await screen.findByText("2 devices report a matching model")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Assign all 2" }));
    await waitFor(() => expect(mockApiPatch).toHaveBeenCalledTimes(2));
    expect(mockApiPatch).toHaveBeenCalledWith("/api/topology/devices/1/meta", { model_id: 5 });
    expect(mockApiPatch).toHaveBeenCalledWith("/api/topology/devices/2/meta", { model_id: 5 });
  });

  it("shows an assign failure on the model card", async () => {
    const user = userEvent.setup();
    mockApiPatch.mockRejectedValue(new Error("boom"));
    renderWithQuery(<ModelsTabContent newEntryTrigger={0} />);
    await user.click(await screen.findByRole("button", { name: "Assign all 2" }));
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
  });
});
