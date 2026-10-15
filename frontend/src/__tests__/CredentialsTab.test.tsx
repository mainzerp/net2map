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
  getStoredUser: () => ({ username: "admin", role: "admin" }),
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

describe("CredentialsTab search", () => {
  const V2_CRED = { ...V3_CRED, id: 8, label: "Edge printer floor", ip: "10.0.9.8", snmp_version: "v2c",
    v3_username: "", discovered_engine_id: null, engine_id_seen_at: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/credentials") return Promise.resolve([V3_CRED, V2_CRED]);
      if (path === "/api/devices") {
        return Promise.resolve([
          { id: 1, ip: "10.0.0.7", sys_name: "GA-CORE-VSF", vendor: "aruba_cx", ports: [] },
          { id: 2, ip: "10.0.5.5", sys_name: "lonely-switch", vendor: "fs", ports: [] },
        ]);
      }
      if (path.startsWith("/api/ping-candidates")) {
        return Promise.resolve([
          { id: 1, ip: "192.168.210.1", hostname: "GA-AP-Werkstatt.ad", mac: null, vendor: null, rtt_ms: 1, dismissed: false },
          { id: 2, ip: "192.168.210.2", hostname: "GA-AP-Container.ad", mac: null, vendor: null, rtt_ms: 1, dismissed: false },
        ]);
      }
      return Promise.resolve([]);
    });
  });

  it("filters credentials by label, IP and discovered sysName", async () => {
    const user = userEvent.setup();
    renderWithQuery(<CredentialsTabContent newEntryTrigger={0} />);
    await screen.findByText("Edge printer floor");
    const search = screen.getByLabelText("Search network devices");

    await user.type(search, "core-vsf");
    await waitFor(() => expect(screen.queryByText("Edge printer floor")).toBeNull());
    expect(screen.getByText("Core v3")).toBeTruthy();
    expect(screen.getByTestId("credential-search-count").textContent).toBe("1 of 2 entries");

    await user.clear(search);
    await user.type(search, "10.0.9");
    await waitFor(() => expect(screen.queryByText("Core v3")).toBeNull());
    expect(screen.getByText("Edge printer floor")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "nothing-matches");
    expect(await screen.findByText("No entries match your search")).toBeTruthy();
  });

  it("also filters unassigned devices and ping candidates", async () => {
    const user = userEvent.setup();
    renderWithQuery(<CredentialsTabContent newEntryTrigger={0} />);
    await screen.findByText("lonely-switch");
    await screen.findByText("GA-AP-Container.ad");

    await user.type(screen.getByLabelText("Search network devices"), "werkstatt");
    await waitFor(() => expect(screen.queryByText("GA-AP-Container.ad")).toBeNull());
    expect(screen.getByText("GA-AP-Werkstatt.ad")).toBeTruthy();
    expect(screen.queryByText("lonely-switch")).toBeNull();
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

describe("CredentialsTab ping only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/credentials") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockApiPost.mockResolvedValue({});
    mockApiPut.mockResolvedValue({});
  });

  it("hides SNMP fields when ping only is checked and posts snmp_enabled=false", async () => {
    const user = userEvent.setup();
    renderWithQuery(<CredentialsTabContent newEntryTrigger={1} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/Community String/)).toBeTruthy();
    expect(within(dialog).getByText("SNMP Version")).toBeTruthy();

    await user.click(within(dialog).getByRole("checkbox", { name: /Ping only/ }));
    expect(within(dialog).queryByLabelText(/Community String/)).toBeNull();
    expect(within(dialog).queryByText("SNMP Version")).toBeNull();
    expect(within(dialog).queryByLabelText(/SNMP Port/)).toBeNull();
    expect(within(dialog).queryByLabelText(/Credential profile/)).toBeNull();

    fireEvent.change(within(dialog).getByLabelText(/Label/), { target: { value: "Printer" } });
    fireEvent.change(within(dialog).getByLabelText(/IP address/), { target: { value: "10.0.5.20" } });
    await user.click(within(dialog).getByRole("button", { name: "+ Add" }));
    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        "/api/credentials",
        expect.objectContaining({ ip: "10.0.5.20", snmp_enabled: false, v3_engine_id: "" }),
      );
    });
  });

  it("sends snmp_enabled=true by default", async () => {
    const user = userEvent.setup();
    renderWithQuery(<CredentialsTabContent newEntryTrigger={1} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Label/), { target: { value: "Core" } });
    fireEvent.change(within(dialog).getByLabelText(/IP address/), { target: { value: "10.0.0.1" } });
    await user.click(within(dialog).getByRole("button", { name: "+ Add" }));
    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith("/api/credentials", expect.objectContaining({ snmp_enabled: true }));
    });
  });

  it("shows a Ping only badge in the list and pre-checks the toggle on edit", async () => {
    const user = userEvent.setup();
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/credentials") {
        return Promise.resolve([{ ...V3_CRED, snmp_enabled: false, discovered_engine_id: null, engine_id_seen_at: null }]);
      }
      return Promise.resolve([]);
    });
    renderWithQuery(<CredentialsTabContent newEntryTrigger={0} />);
    expect(await screen.findByText("Ping only")).toBeTruthy();
    expect(screen.queryByText("v3")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const toggle = within(dialog).getByRole("checkbox", { name: /Ping only/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(within(dialog).queryByLabelText(/Engine ID override/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith("/api/credentials/7", expect.objectContaining({ snmp_enabled: false }));
    });
  });
});
