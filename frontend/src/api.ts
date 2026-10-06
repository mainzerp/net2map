/// <reference types="vite/client" />
// ── Shared API helpers and constants ──────────────────────────────────────────

// Empty string = use relative URLs (works with Vite proxy in dev and nginx in Docker)
// Set VITE_API_URL=http://host:8000 to point to a remote backend
export const API: string = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

// Canonical versioned backend API prefix. Call sites and tests keep using the
// logical, version-less "/api/..." paths (e.g. api.get("/api/devices")); this
// module maps them centrally onto "/api/v1/..." when building request URLs.
// The backend still serves the un-versioned "/api/..." alias, but marks it
// deprecated (Deprecation + Link headers). Paths already starting with
// "/api/v1/" and non-API paths (e.g. "/health") are left unchanged; the
// WebSocket endpoint "/ws/scan-progress" is unversioned.
export const API_VERSION_PREFIX = "/api/v1";

/** Map a logical "/api/..." path onto the canonical versioned path. */
export function versionedPath(path: string): string {
  if (!path.startsWith("/api/")) return path;
  if (path === API_VERSION_PREFIX || path.startsWith(API_VERSION_PREFIX + "/")) return path;
  return API_VERSION_PREFIX + path.slice("/api".length);
}

/** Build the full request URL (backend origin + versioned path) for a logical API path. */
export function apiUrl(path: string): string {
  return `${API}${versionedPath(path)}`;
}

interface ETagCacheEntry {
  etag: string;
  data: unknown;
}

// ETag cache for GET requests that support conditional fetching. A Map keeps
// insertion order, which doubles as LRU order: hits are re-inserted at the end
// and the first (least recently used) entry is evicted once the bound is hit.
const ETAG_CACHE_MAX_ENTRIES = 200;
const _etagCache = new Map<string, ETagCacheEntry>();

/**
 * Normalize a logical request path into an ETag cache key: the versioned path
 * plus query parameters sorted by name, so "/api/x?b=2&a=1" and
 * "/api/v1/x?a=1&b=2" share one entry.
 */
export function etagCacheKey(path: string): string {
  const full = versionedPath(path).split("#")[0];
  const q = full.indexOf("?");
  if (q < 0) return full;
  const params = new URLSearchParams(full.slice(q + 1));
  params.sort();
  const query = params.toString();
  return query ? `${full.slice(0, q)}?${query}` : full.slice(0, q);
}

function _etagCacheGet(key: string): ETagCacheEntry | undefined {
  const entry = _etagCache.get(key);
  if (entry) {
    _etagCache.delete(key);
    _etagCache.set(key, entry);
  }
  return entry;
}

function _etagCacheSet(key: string, entry: ETagCacheEntry): void {
  _etagCache.delete(key);
  _etagCache.set(key, entry);
  while (_etagCache.size > ETAG_CACHE_MAX_ENTRIES) {
    const oldest = _etagCache.keys().next().value;
    if (oldest === undefined) break;
    _etagCache.delete(oldest);
  }
}
let _sessionVersion = 0;
export const SESSION_CHANGED_EVENT = "net2map-session-changed";

function resetSessionCaches(): void {
  _sessionVersion += 1;
  _clearEtagCache();
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}

function clearSession(): void {
  localStorage.removeItem("auth_token");
  localStorage.removeItem("auth_user");
  resetSessionCaches();
}

function checkSession(version: number): void {
  if (version !== _sessionVersion) throw new Error("Session changed; request discarded");
}

function _clearEtagCache(): void {
  _etagCache.clear();
}

// Drop cache entries affected by a mutation: the exact path, any cached
// parent collection of it, and any cached child paths below it. Query strings
// are ignored for the comparison, so filtered list views are dropped as well.
function _invalidateRelated(path: string): void {
  const base = etagCacheKey(path).split("?")[0];
  for (const key of [..._etagCache.keys()]) {
    const keyBase = key.split("?")[0];
    if (keyBase === base || base.startsWith(keyBase + "/") || keyBase.startsWith(base + "/")) {
      _etagCache.delete(key);
    }
  }
}

// Auth token from localStorage (login JWT or legacy SECRET_TOKEN)
export function _getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem("auth_token") || "";
  return token ? { Authorization: "Bearer " + token } : {};
}

export function login(token: string, user: { username: string; role: string }): void {
  localStorage.setItem("auth_token", token);
  localStorage.setItem("auth_user", JSON.stringify(user));
  resetSessionCaches();
}

/**
 * Validate a static access token (legacy single SECRET_TOKEN mode, or a pasted
 * JWT) against GET /api/auth/me without storing it. Resolves to the user the
 * backend associates with the token; rejects with an "HTTP <status>: ..." error.
 */
export async function verifyAccessToken(token: string): Promise<{ username: string; role: string }> {
  const r = await fetch(apiUrl("/api/auth/me"), { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${r.status === 401 ? "Invalid access token" : r.statusText}`);
  }
  const data: { username?: string; role?: string } = await r.json();
  return { username: data.username || "token", role: data.role || "viewer" };
}

export async function logout(): Promise<boolean> {
  const headers = _getAuthHeader();
  // Local logout must complete even while the revocation request is pending.
  clearSession();
  try {
    if (headers.Authorization) {
      const response = await fetch(apiUrl("/api/auth/logout"), {
        method: "POST",
        headers,
      });
      return response.ok;
    }
  } catch {
    return false;
  }
  return true;
}

export function getStoredUser(): { username: string; role: string } | null {
  try { return JSON.parse(localStorage.getItem("auth_user") || "null"); } catch { return null; }
}

export function getStoredToken(): string {
  return localStorage.getItem("auth_token") || "";
}

export function getTokenExpiry(): Date | null {
  const token = getStoredToken();
  if (!token) return null;
  try {
    // JWT payloads are base64url-encoded: convert to standard base64 and pad
    const b64url = token.split(".")[1] || "";
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch { return null; }
}

export function isTokenExpiringSoon(thresholdMinutes: number = 30): boolean {
  const expiry = getTokenExpiry();
  if (!expiry) return false;
  return (expiry.getTime() - Date.now()) < thresholdMinutes * 60 * 1000;
}

/**
 * Extract a clean error message from an exception.
 * Strips the "Error: " prefix that String(ex) produces from Error objects.
 */
export function extractErrorMessage(ex: unknown): string {
  if (ex instanceof Error) return ex.message;
  if (typeof ex === 'string') return ex;
  return 'An unexpected error occurred';
}

// In-flight refresh dedupe: N parallel requests near token expiry must share
// a single POST /api/auth/refresh (the endpoint is rate-limited).
let _refreshPromise: Promise<void> | null = null;

export function refreshTokenIfNeeded(): Promise<void> {
  if (!isTokenExpiringSoon(30)) return Promise.resolve();
  if (!getStoredToken()) return Promise.resolve();
  if (_refreshPromise) return _refreshPromise;
  const version = _sessionVersion;
  _refreshPromise = (async () => {
    try {
      const token = getStoredToken();
      const r = await fetch(apiUrl("/api/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      });
      if (!r.ok) return;  // refresh failed -- let normal 401 handling take over
      const data = await r.json();
      if (data.access_token && version === _sessionVersion && getStoredToken() === token) {
        localStorage.setItem("auth_token", data.access_token);
        localStorage.setItem("auth_user", JSON.stringify({ username: data.username, role: data.role }));
      }
    } catch (_) {
      // Silently fail -- next API call will trigger 401 redirect if truly expired
    }
  })().finally(() => {
    _refreshPromise = null;
  });
  return _refreshPromise;
}

// ── Soft-navigate callback (set by App.tsx) ──────────────────────────────────
type NavigateFn = (path: string, opts?: { replace?: boolean }) => void;
let _navigateFn: NavigateFn | null = null;

export function setApiNavigate(fn: NavigateFn): void {
  _navigateFn = fn;
}

async function _checkOk(r: Response): Promise<Response> {
  if (!r.ok) {
    if (r.status === 401) {
      clearSession();
      if (window.location.pathname !== "/login") {
        if (_navigateFn) {
          _navigateFn("/login", { replace: true });
        } else {
          window.location.href = "/login";
        }
      }
    }
    let msg: string;
    try {
      const body = await r.json();
      msg = body?.error?.message || body?.detail || r.statusText;
    } catch {
      try { msg = await r.text(); } catch { msg = r.statusText; }
    }
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return r;
}

export const api = {
  get: async <T = unknown>(path: string): Promise<T> => {
    const version = _sessionVersion;
    await refreshTokenIfNeeded();
    checkSession(version);
    const key = etagCacheKey(path);
    const headers: Record<string, string> = { ..._getAuthHeader() };
    const cachedEntry = _etagCache.get(key);
    if (cachedEntry) headers["If-None-Match"] = cachedEntry.etag;
    const r = await fetch(apiUrl(path), { headers });
    checkSession(version);
    if (r.status === 304) {
      const hit = _etagCacheGet(key);
      if (hit) return structuredClone(hit.data) as T;
      // Cache miss despite 304 - re-fetch without ETag
      const r2 = await fetch(apiUrl(path), { headers: { ..._getAuthHeader() } });
      checkSession(version);
      await _checkOk(r2);
      const data2 = await r2.json();
      checkSession(version);
      return data2 as T;
    }
    await _checkOk(r);
    const etag = r.headers.get("ETag");
    const data = await r.json();
    checkSession(version);
    if (etag) _etagCacheSet(key, { etag, data: structuredClone(data) });
    return data as T;
  },
  post: <T = unknown>(path: string, body?: unknown): Promise<T> => mutate<T>("POST", path, body),
  put: <T = unknown>(path: string, body?: unknown): Promise<T> => mutate<T>("PUT", path, body),
  patch: <T = unknown>(path: string, body?: unknown): Promise<T> => mutate<T>("PATCH", path, body),
  del: (path: string): Promise<void> => mutate<void>("DELETE", path),
  /** Invalidate one or more ETag cache entries so the next GET fetches fresh data. */
  invalidate: (...paths: string[]): void => { paths.forEach(p => { _etagCache.delete(etagCacheKey(p)); }); },
};

async function mutate<T>(method: string, path: string, body?: unknown): Promise<T> {
  const version = _sessionVersion;
  if (path !== "/api/auth/login") await refreshTokenIfNeeded();
  checkSession(version);
  const response = await fetch(apiUrl(path), {
    method,
    headers: { "Content-Type": "application/json", ..._getAuthHeader() },
    body: JSON.stringify(body),
  });
  checkSession(version);
  await _checkOk(response);
  const data = method === "DELETE" || response.status === 204 ? undefined : await response.json();
  checkSession(version);
  _invalidateRelated(path);
  return data as T;
}

// ── SNMP protocol constants ──────────────────────────────────────────────────
// Visual constants (CABLE_COLORS, VENDOR_*, speedLabel/speedColor) live in
// src/theme/visual.ts.
export const AUTH_PROTOCOLS: string[] = ["MD5","SHA","SHA-224","SHA-256","SHA-384","SHA-512"];
export const PRIV_PROTOCOLS: string[] = ["DES","3DES","AES-128","AES-192","AES-256"];
export const SEC_LEVELS: string[]     = ["noAuthNoPriv","authNoPriv","authPriv"];

// ── Cable-link helpers ───────────────────────────────────────────────────────
// Normalise a port identifier so LLDP port IDs and SNMP ifDescr values
// can be compared case-insensitively after trimming whitespace.
export function normPort(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}

export function buildPortLinkMap<T extends {local_ip: string; local_port: string; remote_ip: string; remote_port: string}>(links: T[]): Record<string, {link: T; role: "from" | "to"}> {
  const m: Record<string, {link: T; role: "from" | "to"}> = {};
  links.forEach(l => {
    m[`${l.local_ip}:${normPort(l.local_port)}`]   = { link: l, role: "from" };
    m[`${l.remote_ip}:${normPort(l.remote_port)}`] = { link: l, role: "to"   };
  });
  return m;
}
