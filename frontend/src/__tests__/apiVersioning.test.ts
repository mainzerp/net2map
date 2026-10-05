import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, apiUrl, API_VERSION_PREFIX, etagCacheKey, login, setApiNavigate, versionedPath } from "../api";

function response(data: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(data), { status, headers });
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  login("token", { username: "user", role: "admin" });
  setApiNavigate(vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("API version mapping", () => {
  it("maps logical /api paths onto /api/v1", () => {
    expect(API_VERSION_PREFIX).toBe("/api/v1");
    expect(versionedPath("/api/devices")).toBe("/api/v1/devices");
    expect(versionedPath("/api/racks/3/layout?x=1")).toBe("/api/v1/racks/3/layout?x=1");
  });

  it("leaves already versioned and non-API paths unchanged", () => {
    expect(versionedPath("/api/v1/x")).toBe("/api/v1/x");
    expect(versionedPath("/api/v1")).toBe("/api/v1");
    expect(versionedPath("/health")).toBe("/health");
    expect(versionedPath("/ws/scan-progress")).toBe("/ws/scan-progress");
    expect(versionedPath("/apix/devices")).toBe("/apix/devices");
  });

  it("apiUrl builds versioned request URLs", () => {
    expect(apiUrl("/api/map-background").endsWith("/api/v1/map-background")).toBe(true);
    expect(apiUrl("/health").endsWith("/health")).toBe(true);
  });

  it("GET requests go to the versioned URL and keep ETag caching per logical path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{ id: 1 }], 200, { ETag: "e1" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/api/devices");
    expect(String(fetchMock.mock.calls[0][0]).endsWith("/api/v1/devices")).toBe(true);

    fetchMock.mockResolvedValue(new Response(null, { status: 304 }));
    const cached = await api.get("/api/devices");
    expect(fetchMock.mock.calls[1][1].headers["If-None-Match"]).toBe("e1");
    expect(cached).toEqual([{ id: 1 }]);
  });

  it("normalizes ETag cache keys (versioned path, sorted query params)", async () => {
    expect(etagCacheKey("/api/logs?q=x&limit=10")).toBe("/api/v1/logs?limit=10&q=x");
    expect(etagCacheKey("/api/v1/logs?limit=10&q=x")).toBe("/api/v1/logs?limit=10&q=x");
    expect(etagCacheKey("/api/devices?")).toBe("/api/v1/devices");

    const fetchMock = vi.fn().mockResolvedValue(response([{ id: 7 }], 200, { ETag: "q1" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/api/logs?q=x&limit=10");
    fetchMock.mockResolvedValue(new Response(null, { status: 304 }));
    const cached = await api.get("/api/v1/logs?limit=10&q=x");
    expect(fetchMock.mock.calls[1][1].headers["If-None-Match"]).toBe("q1");
    expect(cached).toEqual([{ id: 7 }]);
  });

  it("evicts the least recently used ETag entry once the cache is full", async () => {
    const fetchMock = vi.fn((url: string) => {
      const n = String(url).split("/").pop();
      return Promise.resolve(response({ n }, 200, { ETag: `e${n}` }));
    });
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < 200; i++) await api.get(`/api/items/${i}`);
    // Touch entry 0 via a 304 hit so entry 1 becomes the least recently used.
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 304 })));
    expect(await api.get("/api/items/0")).toEqual({ n: "0" });
    await api.get("/api/items/200");

    const headersFor = async (path: string) => {
      fetchMock.mockClear();
      await api.get(path);
      return (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    };
    expect((await headersFor("/api/items/0")).headers["If-None-Match"]).toBe("e0");
    expect((await headersFor("/api/items/1")).headers["If-None-Match"]).toBeUndefined();
  });

  it("mutations drop related cached GETs including filtered list views", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{ id: 1 }], 200, { ETag: "r1" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/api/racks?room=a");
    fetchMock.mockResolvedValue(response({ id: 2 }));
    await api.post("/api/racks", { name: "r" });
    fetchMock.mockResolvedValue(response([{ id: 1 }], 200, { ETag: "r2" }));
    await api.get("/api/racks?room=a");
    expect(fetchMock.mock.calls[2][1].headers["If-None-Match"]).toBeUndefined();
  });

  it("mutations go to the versioned URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.post("/api/racks", { name: "r" });
    expect(String(fetchMock.mock.calls[0][0]).endsWith("/api/v1/racks")).toBe(true);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });
});
