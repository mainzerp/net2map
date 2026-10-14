/**
 * Tests for ping-only adoption: API hooks, the endpoint inspector action, the
 * endpoint table bulk action and the ping-only candidate section in Settings.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { createTestQueryClient, renderWithRouter, stubMemoryStorage } from "./test-utils";
import { ENDPOINTS, TOPOLOGY } from "./inspectorFixtures";

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
let mockRole: string | null = "admin";

vi.mock("../api", () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    delete: vi.fn(),
    invalidate: vi.fn(),
  },
  API: "",
  _getAuthHeader: () => ({}),
  getStoredUser: () => (mockRole ? { username: "user", role: mockRole } : null),
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  normPort: (p: string | null) => (p || "").trim().toLowerCase(),
}));

import {
  queryKeys,
  useAdoptPingOnly,
  useDismissPingCandidates,
  usePingCandidates,
  useRestorePingCandidates,
} from "../hooks/api";
import EndpointInspector from "../features/inspector/EndpointInspector";
import EndpointTable from "../components/EndpointTable";
import PingCandidatesSection from "../components/settings/PingCandidatesSection";

const CANDIDATES = [
  {
    id: 1, ip: "10.0.9.11", rtt_ms: 1.234, first_seen: "2026-01-01T10:00:00Z", last_seen: "2026-01-02T10:00:00Z",
    hostname: "cam-1", mac: "aa:aa:aa:aa:aa:01", vendor: "Axis", dismissed: false,
  },
  {
    id: 2, ip: "10.0.9.12", rtt_ms: null, first_seen: null, last_seen: null,
    hostname: null, mac: null, vendor: null, dismissed: false,
  },
];
const DISMISSED = {
  id: 3, ip: "10.0.9.13", rtt_ms: 4, first_seen: null, last_seen: null,
  hostname: "old-printer", mac: null, vendor: "HP", dismissed: true,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{decodeURIComponent(location.search)}</div>;
}

function baseGet(path: string): Promise<unknown> {
  if (path === "/api/topology") return Promise.resolve(TOPOLOGY);
  if (path === "/api/devices") return Promise.resolve(TOPOLOGY.nodes);
  if (path === "/api/endpoints") return Promise.resolve(ENDPOINTS);
  if (path === "/api/ping-candidates") return Promise.resolve(CANDIDATES);
  if (path === "/api/ping-candidates?include_dismissed=true") return Promise.resolve([...CANDIDATES, DISMISSED]);
  return Promise.resolve([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubMemoryStorage();
  mockRole = "admin";
  mockApiGet.mockImplementation(baseGet);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ping-only hooks", () => {
  function wrapper() {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { Wrapper, spy };
  }

  it("usePingCandidates fetches the default and include_dismissed lists", async () => {
    const { Wrapper } = wrapper();
    const a = renderHook(() => usePingCandidates(false), { wrapper: Wrapper });
    await waitFor(() => expect(a.result.current.data).toHaveLength(2));
    expect(mockApiGet).toHaveBeenCalledWith("/api/ping-candidates");
    const b = renderHook(() => usePingCandidates(true), { wrapper: Wrapper });
    await waitFor(() => expect(b.result.current.data).toHaveLength(3));
    expect(mockApiGet).toHaveBeenCalledWith("/api/ping-candidates?include_dismissed=true");
  });

  it("useAdoptPingOnly posts entries and invalidates dependent queries", async () => {
    mockApiPost.mockResolvedValue({ created: [{ ip: "10.0.9.11", credential_id: 5, device_id: 50 }], skipped: [] });
    const { Wrapper, spy } = wrapper();
    const { result } = renderHook(() => useAdoptPingOnly(), { wrapper: Wrapper });
    const res = await result.current.mutateAsync([{ ip: "10.0.9.11", label: "cam-1" }]);
    expect(res.created[0].device_id).toBe(50);
    expect(mockApiPost).toHaveBeenCalledWith("/api/credentials/ping-only", {
      entries: [{ ip: "10.0.9.11", label: "cam-1" }],
    });
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    for (const key of [
      queryKeys.topology, queryKeys.devices, queryKeys.credentials, queryKeys.endpoints, queryKeys.pingCandidates(),
    ]) {
      expect(keys).toContain(JSON.stringify(key));
    }
  });

  it("dismiss and restore post the ids", async () => {
    mockApiPost.mockResolvedValue({ dismissed: 2, restored: 1 });
    const { Wrapper } = wrapper();
    const d = renderHook(() => useDismissPingCandidates(), { wrapper: Wrapper });
    await d.result.current.mutateAsync([1, 2]);
    expect(mockApiPost).toHaveBeenCalledWith("/api/ping-candidates/dismiss", { ids: [1, 2] });
    const r = renderHook(() => useRestorePingCandidates(), { wrapper: Wrapper });
    await r.result.current.mutateAsync([3]);
    expect(mockApiPost).toHaveBeenCalledWith("/api/ping-candidates/restore", { ids: [3] });
  });
});

describe("EndpointInspector adopt as ping-only", () => {
  function renderInspector(id = 10) {
    return renderWithRouter(
      <>
        <EndpointInspector id={id} titleId="t" />
        <LocationProbe />
      </>,
      { route: `/devices?inspect=endpoint:${id}` },
    );
  }

  it("adopts the endpoint with its hostname as label and offers to open the device", async () => {
    mockApiPost.mockResolvedValue({ created: [{ ip: "10.0.5.20", credential_id: 9, device_id: 77 }], skipped: [] });
    renderInspector();
    const button = await screen.findByRole("button", { name: "Adopt as ping-only device" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/credentials/ping-only", {
        entries: [{ ip: "10.0.5.20", label: "printer-lobby" }],
      }),
    );
    expect(await screen.findByText("Added 10.0.5.20 as ping-only device")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open device" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("inspect=device:77"));
  });

  it("toasts the skip reason", async () => {
    mockApiPost.mockResolvedValue({ created: [], skipped: [{ ip: "10.0.5.20", reason: "exists" }] });
    renderInspector();
    const button = await screen.findByRole("button", { name: "Adopt as ping-only device" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByText("10.0.5.20: Already managed")).toBeTruthy();
  });

  it("is disabled when the IP is already a device or has a credential", async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/api/endpoints") {
        return Promise.resolve([
          { ...ENDPOINTS[0], id: 11, ip: "10.0.1.6" },
          { ...ENDPOINTS[0], id: 12, ip: "10.0.7.7" },
          { ...ENDPOINTS[0], id: 13, ip: null },
        ]);
      }
      if (path === "/api/credentials") return Promise.resolve([{ id: 1, ip: "10.0.7.7", label: "x" }]);
      return baseGet(path);
    });
    const one = renderInspector(11);
    let button = await screen.findByRole("button", { name: "Adopt as ping-only device" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(button.parentElement?.getAttribute("title")).toBe("This IP is already a managed device");
    one.unmount();

    const two = renderInspector(12);
    button = await screen.findByRole("button", { name: "Adopt as ping-only device" });
    await waitFor(() =>
      expect(button.parentElement?.getAttribute("title")).toBe("A credential for this IP already exists"),
    );
    expect((button as HTMLButtonElement).disabled).toBe(true);
    two.unmount();

    renderInspector(13);
    button = await screen.findByRole("button", { name: "Adopt as ping-only device" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.parentElement?.getAttribute("title")).toBe("Endpoint has no IP address");
  });

  it("is hidden for viewers", async () => {
    mockRole = "viewer";
    renderInspector();
    await screen.findByRole("button", { name: "Go to port" });
    expect(screen.queryByRole("button", { name: "Adopt as ping-only device" })).toBeNull();
    expect(mockApiGet).not.toHaveBeenCalledWith("/api/credentials");
  });
});

describe("EndpointTable bulk adopt", () => {
  const rows = [
    { id: 1, mac: "aa:00:00:00:00:01", ip: "10.0.8.1", hostname: "pc1", ignored: false, first_seen: null, last_seen: null, notes: null, found_on: [] },
    { id: 2, mac: "aa:00:00:00:00:02", ip: null, hostname: null, ignored: false, first_seen: null, last_seen: null, notes: null, found_on: [] },
    { id: 3, mac: "aa:00:00:00:00:03", ip: "10.0.8.3", hostname: null, ignored: false, first_seen: null, last_seen: null, notes: null, found_on: [] },
  ];

  it("adopts selected endpoints with an IP and toasts a summary", async () => {
    mockApiGet.mockImplementation((path: string) => (path === "/api/endpoints" ? Promise.resolve(rows) : baseGet(path)));
    mockApiPost.mockResolvedValue({
      created: [{ ip: "10.0.8.1", credential_id: 1, device_id: 1 }],
      skipped: [{ ip: "10.0.8.3", reason: "exists" }],
    });
    renderWithRouter(<EndpointTable />);
    await screen.findByText("aa:00:00:00:00:01");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    fireEvent.click(screen.getByRole("button", { name: "Adopt as ping-only" }));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/credentials/ping-only", {
        entries: [{ ip: "10.0.8.1", label: "pc1" }, { ip: "10.0.8.3" }],
      }),
    );
    expect(await screen.findByText("1 added, 1 skipped")).toBeTruthy();
  });

  it("hides the bulk adopt action for viewers", async () => {
    mockRole = "viewer";
    mockApiGet.mockImplementation((path: string) => (path === "/api/endpoints" ? Promise.resolve(rows) : baseGet(path)));
    renderWithRouter(<EndpointTable />);
    await screen.findByText("aa:00:00:00:00:01");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(screen.queryByRole("button", { name: "Adopt as ping-only" })).toBeNull();
  });
});

describe("PingCandidatesSection", () => {
  it("lists candidates and adopts the selected ones with hostname labels", async () => {
    mockApiPost.mockResolvedValue({
      created: [
        { ip: "10.0.9.11", credential_id: 1, device_id: 1 },
        { ip: "10.0.9.12", credential_id: 2, device_id: 2 },
      ],
      skipped: [],
    });
    renderWithRouter(<PingCandidatesSection />);
    expect(await screen.findByText("10.0.9.11")).toBeTruthy();
    expect(screen.getByText("cam-1")).toBeTruthy();
    expect(screen.getByText("Axis")).toBeTruthy();
    expect(screen.getByText("1.2 ms")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    fireEvent.click(screen.getByRole("button", { name: "Adopt selected" }));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/credentials/ping-only", {
        entries: [{ ip: "10.0.9.11", label: "cam-1" }, { ip: "10.0.9.12" }],
      }),
    );
    expect(await screen.findByText("2 added, 0 skipped")).toBeTruthy();
  });

  it("adopts and dismisses single rows and dismisses the selection", async () => {
    mockApiPost.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/api/credentials/ping-only"
          ? { created: [{ ip: "10.0.9.12", credential_id: 2, device_id: 2 }], skipped: [] }
          : { dismissed: 1 },
      ),
    );
    renderWithRouter(<PingCandidatesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Adopt 10.0.9.12" }));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/credentials/ping-only", { entries: [{ ip: "10.0.9.12" }] }),
    );
    expect(await screen.findByText("Added 10.0.9.12 as ping-only device")).toBeTruthy();

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Dismiss 10.0.9.11" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss 10.0.9.11" }));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/ping-candidates/dismiss", { ids: [1] }));

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Dismiss 10.0.9.11" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss selected" }));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/ping-candidates/dismiss", { ids: [2] }));
  });

  it("shows dismissed candidates on toggle and restores them", async () => {
    mockApiPost.mockResolvedValue({ restored: 1 });
    renderWithRouter(<PingCandidatesSection />);
    await screen.findByText("10.0.9.11");
    expect(screen.queryByText("10.0.9.13")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show dismissed" }));
    expect(await screen.findByText("10.0.9.13")).toBeTruthy();
    const row = screen.getByText("10.0.9.13").closest("tr") as HTMLElement;
    expect(within(row).getByText("dismissed")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Adopt/ })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Restore 10.0.9.13" }));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith("/api/ping-candidates/restore", { ids: [3] }));
  });

  it("shows an empty state when there are no candidates", async () => {
    mockApiGet.mockImplementation((path: string) =>
      path.startsWith("/api/ping-candidates") ? Promise.resolve([]) : baseGet(path),
    );
    renderWithRouter(<PingCandidatesSection />);
    expect(await screen.findByText("No ping-only candidates")).toBeTruthy();
  });

  it("is read-only for viewers", async () => {
    mockRole = "viewer";
    renderWithRouter(<PingCandidatesSection />);
    expect(await screen.findByText("10.0.9.11")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Adopt|Dismiss|Restore/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Select all rows" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show dismissed" }));
    expect(await screen.findByText("10.0.9.13")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
  });
});
