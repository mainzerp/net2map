/**
 * Device classes tab: new-class defaults and the rack-required assignment filter.
 */
import { type ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

import ClassesTabContent from "../components/settings/SwitchClassesTab";

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function device(id: number, name: string, rackId: number | null) {
  return {
    id, ip: `10.0.0.${id}`, hostname: name, sys_name: name, vendor: "", model: "",
    rack_id: rackId, class_id: null, model_id: null, ignored: false,
  };
}

describe("SwitchClassesTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/switch-classes") {
        return Promise.resolve([
          { id: 1, label: "Core", color: "#336699", description: "", allow_outside_rack: false },
        ]);
      }
      if (path === "/api/devices") {
        return Promise.resolve([device(1, "racked-sw", 7), device(2, "loose-sw", null)]);
      }
      return Promise.resolve([]);
    });
    mockApiPatch.mockResolvedValue({});
  });

  it("defaults a new device class to showing devices without a rack", async () => {
    renderWithQuery(<ClassesTabContent newEntryTrigger={1} />);
    expect(await screen.findByText("New device class")).toBeTruthy();
    const checkbox = screen.getByRole("checkbox", { name: "Show devices without a rack on the map" });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/unracked ones are hidden from the map/)).toBeTruthy();
  });

  it("only offers racked devices for a rack-required class", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ClassesTabContent newEntryTrigger={0} />);
    await screen.findByText("Core");
    expect(screen.getByText("Rack required")).toBeTruthy();
    expect(screen.getByText("Only devices in a rack can get this class (rack required).")).toBeTruthy();

    await user.click(await screen.findByRole("combobox", { name: "Assign device" }));
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("racked-sw");
  });

  it("shows an assign failure on the class card", async () => {
    const user = userEvent.setup();
    mockApiPatch.mockRejectedValue(new Error("OUTSIDE_RACK_NOT_ALLOWED"));
    renderWithQuery(<ClassesTabContent newEntryTrigger={0} />);
    await screen.findByText("Core");
    await user.click(await screen.findByRole("combobox", { name: "Assign device" }));
    await user.click(within(screen.getByRole("listbox")).getAllByRole("option")[0]);
    expect((await screen.findByRole("alert")).textContent).toContain("OUTSIDE_RACK_NOT_ALLOWED");
  });
});
