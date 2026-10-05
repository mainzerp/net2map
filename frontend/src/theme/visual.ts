// ── Visual constants ─────────────────────────────────────────────────────────
// Colors, icons and labels used to render topology data. Pure presentation
// concerns; transport lives in api.ts.

// "Cartography" data palette: mid-tone terracotta, ink blue, amber, sage, plum,
// slate-teal, rose clay and olive. Every entry keeps >= 3:1 contrast against
// the surface and panel tokens of BOTH themes (light paper and dark ink), so
// cables, port fills and speed labels stay readable without per-theme values.
const PALETTE = {
  terracotta: "#c0603f",
  inkBlue: "#5a86b8",
  amber: "#b07f2e",
  sage: "#5e9472",
  plum: "#9a6a9a",
  slateTeal: "#3f8a8c",
  roseClay: "#b5566a",
  olive: "#7d7f3a",
  slate: "#6b7a86",
} as const;

export const CABLE_COLORS: string[] = [
  PALETTE.terracotta,
  PALETTE.inkBlue,
  PALETTE.amber,
  PALETTE.sage,
  PALETTE.plum,
  PALETTE.slateTeal,
  PALETTE.roseClay,
  PALETTE.olive,
];

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
  mbps >= 25000 ? PALETTE.plum :
  mbps >= 10000 ? PALETTE.inkBlue :
  mbps >= 1000  ? PALETTE.sage : PALETTE.amber;

export const VENDOR_LABEL: Record<string, string> = { aruba_cx: "Aruba CX", fs: "FS.com", unifi: "UniFi", opnsense: "OPNsense", generic: "Generic" };
export const VENDOR_COLOR: Record<string, string> = { aruba_cx: PALETTE.amber, fs: PALETTE.slateTeal, unifi: PALETTE.inkBlue, opnsense: PALETTE.terracotta, generic: PALETTE.slate };
export const VENDOR_ICON: Record<string, string>  = { aruba_cx: "[AX]", fs: "[FS]", unifi: "[UF]", opnsense: "[OP]", generic: "[--]" };
