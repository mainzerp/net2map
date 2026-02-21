// ── Shared API helpers and constants ──────────────────────────────────────────

// Empty string = use relative URLs (works with Vite proxy in dev and nginx in Docker)
// Set VITE_API_URL=http://host:8000 to point to a remote backend
export const API = import.meta.env.VITE_API_URL ?? "";

export const api = {
  get:   (path)       => fetch(`${API}${path}`).then(r => r.json()),
  post:  (path, body) => fetch(`${API}${path}`, { method:"POST",   headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) }).then(r => r.json()),
  put:   (path, body) => fetch(`${API}${path}`, { method:"PUT",    headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) }).then(r => r.json()),
  patch: (path, body) => fetch(`${API}${path}`, { method:"PATCH",  headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) }).then(r => r.json()),
  del:   (path)       => fetch(`${API}${path}`, { method:"DELETE" }),
};

// ── Visual constants ─────────────────────────────────────────────────────────
export const CABLE_COLORS = ["#f472b6","#fb923c","#a78bfa","#34d399","#fbbf24","#60a5fa","#f87171","#e879f9"];

export const speedLabel = mbps =>
  mbps >= 100000 ? "100G" :
  mbps >= 10000  ? "10G"  :
  mbps >= 1000   ? "1G"   :
  mbps >= 100    ? "100M" :
  mbps > 0       ? "10M"  : "?";

export const speedColor = mbps =>
  mbps >= 10000 ? "#22d3ee" :
  mbps >= 1000  ? "#22c55e" : "#f59e0b";

export const VENDOR_LABEL = { aruba_cx:"Aruba CX", fs:"FS.com", unifi:"UniFi", generic:"Generic" };
export const VENDOR_COLOR = { aruba_cx:"#f59e0b", fs:"#22d3ee", unifi:"#60a5fa", generic:"#475569" };
export const VENDOR_ICON  = { aruba_cx:"[AX]", fs:"[FS]", unifi:"[UF]", generic:"[--]" };

export const AUTH_PROTOCOLS = ["MD5","SHA","SHA-224","SHA-256","SHA-384","SHA-512"];
export const PRIV_PROTOCOLS = ["DES","3DES","AES-128","AES-192","AES-256"];
export const SEC_LEVELS     = ["noAuthNoPriv","authNoPriv","authPriv"];

// ── Cable-link helpers ───────────────────────────────────────────────────────
export function buildPortLinkMap(links) {
  const m = {};
  links.forEach(l => {
    m[`${l.local_ip}:${l.local_port}`]   = { link: l, role: "from" };
    m[`${l.remote_ip}:${l.remote_port}`] = { link: l, role: "to"   };
  });
  return m;
}
