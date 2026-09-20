// ── Visual constants ─────────────────────────────────────────────────────────
// Colors, icons and labels used to render topology data. Pure presentation
// concerns; transport lives in api.ts.

export const CABLE_COLORS: string[] = ["#f472b6", "#fb923c", "#a78bfa", "#34d399", "#fbbf24", "#60a5fa", "#f87171", "#e879f9"];

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

export const VENDOR_LABEL: Record<string, string> = { aruba_cx: "Aruba CX", fs: "FS.com", unifi: "UniFi", opnsense: "OPNsense", generic: "Generic" };
export const VENDOR_COLOR: Record<string, string> = { aruba_cx: "#f59e0b", fs: "#22d3ee", unifi: "#60a5fa", opnsense: "#e85d04", generic: "#475569" };
export const VENDOR_ICON: Record<string, string>  = { aruba_cx: "[AX]", fs: "[FS]", unifi: "[UF]", opnsense: "[OP]", generic: "[--]" };
