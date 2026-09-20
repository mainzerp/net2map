/**
 * Focused tests for the settings tabs: RacksTab height_u handling and the
 * SnmpProfilesTab create flow with query invalidation.
 */
import React, { type ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../components/ToastProvider";

// Mock the api module (all importers share this mock).
const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();
const mockApiDel = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: (...args: unknown[]) => mockApiPut(...args),
    del: (...args: unknown[]) => mockApiDel(...args),
    invalidate: vi.fn(),
  },
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  AUTH_PROTOCOLS: ["SHA-256"],
  PRIV_PROTOCOLS: ["AES-128"],
  SEC_LEVELS: ["noAuthNoPriv", "authNoPriv", "authPriv"],
  API: "",
}));

// Must import after mocks are set up
import RacksTabContent from "../components/settings/RacksTab";
import SnmpProfilesTabContent from "../components/settings/SnmpProfilesTab";

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RacksTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/racks") {
        return Promise.resolve([
          { id: 1, label: "Rack A", room: "RZ-01", description: "", height_u: 42, row_pos: null, col_pos: null },
        ]);
      }
      if (path === "/api/devices") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockApiPut.mockResolvedValue({});
  });

  it("renders the height_u field and submits it on save", async () => {
    const user = userEvent.setup();
    renderWithQuery(<RacksTabContent newEntryTrigger={0} />);

    // Wait for the rack card, then open the edit dialog
    await screen.findByText("Rack A");
    expect(screen.getByText("42U")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Edit" }));

    // The edit dialog shows the Height (U) input with the rack's value
    const heightInput = await screen.findByLabelText(/Height \(U\)/);
    expect((heightInput as HTMLInputElement).value).toBe("42");

    fireEvent.change(heightInput, { target: { value: "24" } });
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith(
        "/api/racks/1",
        expect.objectContaining({ label: "Rack A", height_u: 24 }),
      );
    });
  });

  it("falls back to the 42U default when height is cleared", async () => {
    const user = userEvent.setup();
    renderWithQuery(<RacksTabContent newEntryTrigger={0} />);

    await screen.findByText("Rack A");
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const heightInput = await screen.findByLabelText(/Height \(U\)/);
    fireEvent.change(heightInput, { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith(
        "/api/racks/1",
        expect.objectContaining({ height_u: 42 }),
      );
    });
  });
});

describe("SnmpProfilesTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/snmp-profiles") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockApiPost.mockResolvedValue({});
  });

  it("creates a profile and invalidates the profiles query", async () => {
    const user = userEvent.setup();
    // newEntryTrigger=1 opens the create dialog immediately
    renderWithQuery(<SnmpProfilesTabContent newEntryTrigger={1} />);

    const nameInput = await screen.findByLabelText(/Profile name/);
    await user.type(nameInput, "Test profile");
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    // The create call hits the API with the entered payload
    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        "/api/snmp-profiles",
        expect.objectContaining({ label: "Test profile", snmp_version: "v2c" }),
      );
    });

    // After the mutation the profiles query is invalidated and refetches
    const profileGets = () =>
      mockApiGet.mock.calls.filter(([path]) => path === "/api/snmp-profiles").length;
    await waitFor(() => {
      expect(profileGets()).toBeGreaterThanOrEqual(2);
    });
  });
});
