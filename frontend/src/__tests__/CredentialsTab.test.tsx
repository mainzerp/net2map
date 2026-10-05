/**
 * Focused tests for CredentialsTab engine ID handling: read-only display of the
 * discovered engine ID and inline validation of the v3 engine ID override.
 */
import React, { type ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../components/ToastProvider";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();
const mockApiDel = vi.fn();

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: (...args: unknown[]) => mockApiPut(...args),
    patch: vi.fn(),
    del: (...args: unknown[]) => mockApiDel(...args),
    invalidate: vi.fn(),
  },
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  AUTH_PROTOCOLS: ["SHA-256"],
  PRIV_PROTOCOLS: ["AES-128"],
  SEC_LEVELS: ["noAuthNoPriv", "authNoPriv", "authPriv"],
  API: "",
}));

import CredentialsTabContent from "../components/settings/CredentialsTab";
import { validateEngineId, normalizeEngineId } from "../components/settings/engineId";

const V3_CRED = {
  id: 7, label: "Core v3", ip: "10.0.0.7", priority: 0, snmp_port: 161, enabled: true,
  profile_id: null, device_id: null, snmp_version: "v3", community: "",
  v3_security_level: "authPriv", v3_username: "mon", v3_auth_protocol: "SHA-256",
  v3_auth_password: "***", v3_priv_protocol: "AES-128", v3_priv_password: "***",
  v3_engine_id: null,
  discovered_engine_id: "80000b85030011223344ff",
  engine_id_seen_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
};

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("engineId helpers", () => {
  it("normalizes prefix, separators and case", () => {
    expect(normalizeEngineId("0x80:00:0B:85 03")).toBe("80000b8503");
  });
  it("validates hex, length parity and octet range", () => {
    expect(validateEngineId("")).toBe("");
    expect(validateEngineId("80000b8503")).toBe("");
    expect(validateEngineId("80000b85zz")).toMatch(/hex/);
    expect(validateEngineId("80000b850")).toMatch(/even/);
    expect(validateEngineId("01020304")).toMatch(/5-32 octets/);
    expect(validateEngineId("ab".repeat(33))).toMatch(/5-32 octets/);
  });
});

describe("CredentialsTab engine ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/credentials") return Promise.resolve([V3_CRED]);
      return Promise.resolve([]);
    });
    mockApiPut.mockResolvedValue({});
  });

  it("renders the discovered engine id read-only with relative seen time", async () => {
    renderWithQuery(<CredentialsTabContent newEntryTrigger={0} />);
    const value = await screen.findByTestId("engine-id");
    expect(value.textContent).toBe("80000b85030011223344ff");
    expect(screen.getByText("seen 5m ago")).toBeTruthy();
  });

  it("validates the override inline and submits the normalized value", async () => {
    const user = userEvent.setup();
    renderWithQuery(<CredentialsTabContent newEntryTrigger={0} />);
    await screen.findByTestId("engine-id");
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(/Engine ID override/);
    expect(within(dialog).getByText(/Leave empty to use automatic discovery/)).toBeTruthy();

    fireEvent.change(input, { target: { value: "01020304" } });
    expect(within(dialog).getByText(/5-32 octets/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(mockApiPut).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "0x80:00:0B:85:03" } });
    expect(within(dialog).queryByText(/5-32 octets/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith(
        "/api/credentials/7",
        expect.objectContaining({ v3_engine_id: "80000b8503" }),
      );
    });
  });

  it("hides the override field for v2c credentials", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/credentials") {
        return Promise.resolve([{ ...V3_CRED, snmp_version: "v2c", discovered_engine_id: null, engine_id_seen_at: null }]);
      }
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    renderWithQuery(<CredentialsTabContent newEntryTrigger={0} />);
    await screen.findByText("Core v3");
    expect(screen.queryByTestId("engine-id")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(/Engine ID override/)).toBeNull();
  });
});
