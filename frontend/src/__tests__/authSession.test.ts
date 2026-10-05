import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { api, getStoredToken, login, logout, refreshTokenIfNeeded, SESSION_CHANGED_EVENT, setApiNavigate } from "../api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

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
  login("first-token", { username: "first", role: "admin" });
  setApiNavigate(vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("authentication boundaries", () => {
  it("clears credentials and query cache before revocation completes", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const client = new QueryClient();
    client.setQueryData(["credentials"], [{ id: 1 }]);
    const reset = () => client.clear();
    window.addEventListener(SESSION_CHANGED_EVENT, reset);
    try {
      const result = logout();
      expect(getStoredToken()).toBe("");
      expect(client.getQueryData(["credentials"])).toBeUndefined();
      pending.resolve(response({}, 503));
      expect(await result).toBe(false);
    } finally {
      window.removeEventListener(SESSION_CHANGED_EVENT, reset);
      client.clear();
    }
  });

  it("does not erase a new login when old revocation finishes", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const result = logout();
    login("second-token", { username: "second", role: "viewer" });
    pending.resolve(response({}));
    await result;
    expect(getStoredToken()).toBe("second-token");
  });

  it("does not restore a logged-out session from an in-flight refresh", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchMock);
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 }));
    login(`header.${payload}.signature`, { username: "first", role: "admin" });
    const refresh = refreshTokenIfNeeded();
    await logout();
    pending.resolve(response({ access_token: "refreshed", username: "first", role: "admin" }));
    await refresh;
    expect(getStoredToken()).toBe("");
  });

  it("discards old responses instead of leaking data into the next session", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const request = api.get("/api/credentials");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    login("second-token", { username: "second", role: "viewer" });
    pending.resolve(response([{ secret: "old-session-data" }], 200, { ETag: "old" }));
    await expect(request).rejects.toThrow("Session changed");
  });

  it("ignores an old unauthorized response after a new login", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const request = api.get("/api/devices");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    login("second-token", { username: "second", role: "viewer" });
    pending.resolve(response({ detail: "Expired" }, 401));
    await expect(request).rejects.toThrow("Session changed");
    expect(getStoredToken()).toBe("second-token");
  });

  it("does not reuse ETags across logins", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{ id: 1 }], 200, { ETag: "private" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/api/devices");
    login("second-token", { username: "second", role: "viewer" });
    fetchMock.mockResolvedValue(response([]));
    await api.get("/api/devices");
    expect(fetchMock.mock.calls[1][1].headers["If-None-Match"]).toBeUndefined();
  });
});
