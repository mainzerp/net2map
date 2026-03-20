/// <reference types="vite/client" />
// ── Shared API helpers and constants ──────────────────────────────────────────

// Empty string = use relative URLs (works with Vite proxy in dev and nginx in Docker)
// Set VITE_API_URL=http://host:8000 to point to a remote backend
export const API: string = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

interface ETagCacheEntry {
  etag: string;
  data: unknown;
}

// Auth token from localStorage (JWT or legacy token)
export function _getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem("auth_token") || import.meta.env.VITE_API_TOKEN || "";
  return token ? { Authorization: "Bearer " + token } : {};
}

export function login(token: string, user: { username: string; role: string }): void {
  localStorage.setItem("auth_token", token);
  localStorage.setItem("auth_user", JSON.stringify(user));
}

export async function logout(): Promise<void> {
  try {
    const headers = _getAuthHeader();
    if (headers.Authorization) {
      await fetch(`${API}/api/auth/logout`, {
        method: "POST",
        headers,
      });
    }
  } catch {
    // Best-effort -- still clear local state even if backend call fails
  }
  localStorage.removeItem("auth_token");
  localStorage.removeItem("auth_user");
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
    const payload = JSON.parse(atob(token.split(".")[1]));
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

export async function refreshTokenIfNeeded(): Promise<void> {
  if (!isTokenExpiringSoon(30)) return;
  const token = getStoredToken();
  if (!token) return;
  try {
    const r = await fetch(`${API}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    });
    if (!r.ok) return;  // refresh failed -- let normal 401 handling take over
    const data = await r.json();
    if (data.access_token) {
      login(data.access_token, { username: data.username, role: data.role });
    }
  } catch (_) {
    // Silently fail -- next API call will trigger 401 redirect if truly expired
  }
}

// ── Soft-navigate callback (set by App.tsx) ──────────────────────────────────
type NavigateFn = (path: string, opts?: { replace?: boolean }) => void;
let _navigateFn: NavigateFn | null = null;

export function setApiNavigate(fn: NavigateFn): void {
  _navigateFn = fn;
}

// ETag cache for GET requests that support conditional fetching
const _etagCache: Record<string, ETagCacheEntry> = {};

async function _checkOk(r: Response): Promise<Response> {
  if (!r.ok) {
    if (r.status === 401) {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
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
  get: async (path: string): Promise<any> => {
    await refreshTokenIfNeeded();
    const headers: Record<string, string> = { ..._getAuthHeader() };
    if (_etagCache[path]) headers["If-None-Match"] = _etagCache[path].etag;
    const r = await fetch(`${API}${path}`, { headers });
    if (r.status === 304) {
      if (_etagCache[path]) return structuredClone(_etagCache[path].data);
      // Cache miss despite 304 - re-fetch without ETag
      const r2 = await fetch(`${API}${path}`, { headers: { ..._getAuthHeader() } });
      await _checkOk(r2);
      const data2 = await r2.json();
      return data2;
    }
    await _checkOk(r);
    const etag = r.headers.get("ETag");
    const data = await r.json();
    if (etag) {
      _etagCache[path] = { etag, data: structuredClone(data) };
      const keys = Object.keys(_etagCache);
      if (keys.length > 200) {
        // Evict oldest 20% to avoid thrashing
        const evictCount = Math.ceil(keys.length * 0.2);
        for (let i = 0; i < evictCount; i++) {
          delete _etagCache[keys[i]];
        }
      }
    }
    return data;
  },
  post:  async (path: string, body?: unknown): Promise<any> => { await refreshTokenIfNeeded(); return fetch(`${API}${path}`, { method:"POST",   headers:{"Content-Type":"application/json", ..._getAuthHeader()}, body: JSON.stringify(body) }).then(_checkOk).then(r => r.json()); },
  put:   async (path: string, body?: unknown): Promise<any> => { await refreshTokenIfNeeded(); return fetch(`${API}${path}`, { method:"PUT",    headers:{"Content-Type":"application/json", ..._getAuthHeader()}, body: JSON.stringify(body) }).then(_checkOk).then(r => r.json()); },
  patch: async (path: string, body?: unknown): Promise<any> => { await refreshTokenIfNeeded(); return fetch(`${API}${path}`, { method:"PATCH",  headers:{"Content-Type":"application/json", ..._getAuthHeader()}, body: JSON.stringify(body) }).then(_checkOk).then(r => r.json()); },
  del:   async (path: string): Promise<void> => { await refreshTokenIfNeeded(); await fetch(`${API}${path}`, { method:"DELETE", headers:{ ..._getAuthHeader() } }).then(_checkOk); },
  /** Invalidate one or more ETag cache entries so the next GET fetches fresh data. */
  invalidate: (...paths: string[]): void => { paths.forEach(p => { delete _etagCache[p]; }); },
};

// ── Visual constants ─────────────────────────────────────────────────────────
export const CABLE_COLORS: string[] = ["#f472b6","#fb923c","#a78bfa","#34d399","#fbbf24","#60a5fa","#f87171","#e879f9"];

// NOTE: This logic is mirrored in backend/snmp_scanner.py speed_label().
// Any changes here must be reflected there too.
export const speedLabel = (mbps: number): string =>
  mbps >= 100000 ? "100G" :
  mbps >= 40000  ? "40G"  :
  mbps >= 25000  ? "25G"  :
  mbps >= 10000  ? "10G"  :
  mbps >= 1000   ? "1G"   :
  mbps >= 100    ? "100M" :
  mbps > 0       ? "10M"  : "?";

export const speedColor = (mbps: number): string =>
  mbps >= 25000 ? "#a78bfa" :
  mbps >= 10000 ? "#22d3ee" :
  mbps >= 1000  ? "#22c55e" : "#f59e0b";

export const VENDOR_LABEL: Record<string, string> = { aruba_cx:"Aruba CX", fs:"FS.com", unifi:"UniFi", opnsense:"OPNsense", generic:"Generic" };
export const VENDOR_COLOR: Record<string, string> = { aruba_cx:"#f59e0b", fs:"#22d3ee", unifi:"#60a5fa", opnsense:"#e85d04", generic:"#475569" };
export const VENDOR_ICON: Record<string, string>  = { aruba_cx:"[AX]", fs:"[FS]", unifi:"[UF]", opnsense:"[OP]", generic:"[--]" };

export const AUTH_PROTOCOLS: string[] = ["MD5","SHA","SHA-224","SHA-256","SHA-384","SHA-512"];
export const PRIV_PROTOCOLS: string[] = ["DES","3DES","AES-128","AES-192","AES-256"];
export const SEC_LEVELS: string[]     = ["noAuthNoPriv","authNoPriv","authPriv"];

// ── Cable-link helpers ───────────────────────────────────────────────────────
// Normalise a port identifier so LLDP port IDs and SNMP ifDescr values
// can be compared case-insensitively after trimming whitespace.
export function normPort(s: string): string {
  return (s || "").trim().toLowerCase();
}

export function buildPortLinkMap<T extends {local_ip: string; local_port: string; remote_ip: string; remote_port: string}>(links: T[]): Record<string, {link: T; role: string}> {
  const m: Record<string, {link: T; role: string}> = {};
  links.forEach(l => {
    m[`${l.local_ip}:${normPort(l.local_port)}`]   = { link: l, role: "from" };
    m[`${l.remote_ip}:${normPort(l.remote_port)}`] = { link: l, role: "to"   };
  });
  return m;
}
