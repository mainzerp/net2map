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

// Default for a user-chosen switch class color (data, not UI chrome). A native
// color input needs a hex value.
export const DEFAULT_SWITCH_CLASS_COLOR: string = PALETTE.inkBlue;

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

// Map a speed label ("10G", "100M", ...) back to Mbps; 0 for unknown labels.
export const SPEED_LABEL_TO_MBPS: Record<string, number> = {
  "100G": 100000,
  "40G": 40000,
  "25G": 25000,
  "10G": 10000,
  "1G": 1000,
  "100M": 100,
  "10M": 10,
};

export const speedLabelToMbps = (label: string | null | undefined): number =>
  SPEED_LABEL_TO_MBPS[label || ""] ?? 0;

// Cartographic stroke weight for a link: thicker ink for faster links, like
// road classes on a printed map. Unknown speed (0) draws as the thinnest line.
export const speedStrokeWidth = (mbps: number): number =>
  mbps >= 25000 ? 3 :
  mbps >= 10000 ? 2.25 :
  mbps >= 1000  ? 1.5 : 1;

export const VENDOR_LABEL: Record<string, string> = { aruba_cx: "Aruba CX", fs: "FS.com", unifi: "UniFi", opnsense: "OPNsense", eaton: "Eaton", hpe_ups: "HPE UPS", hpe_ilo: "HPE iLO", generic: "Generic" };
export const VENDOR_COLOR: Record<string, string> = { aruba_cx: PALETTE.amber, fs: PALETTE.slateTeal, unifi: PALETTE.inkBlue, opnsense: PALETTE.terracotta, eaton: PALETTE.olive, hpe_ups: PALETTE.sage, hpe_ilo: PALETTE.plum, generic: PALETTE.slate };

// Vendor pill badge: short readable name plus the vendor color. The vendor
// colors are mid-tones tuned for >= 3:1 against panel in both themes, which is
// enough for borders/strips (non-text) but NOT for text (all measure 3.5-4.4:1
// on light panel and 3.5-4.3:1 on dark panel). Badges therefore draw the
// border and a dot in the vendor color and render the text in text-primary.
export interface VendorBadgeSpec {
  short: string;
  name: string;
  color: string;
}

export const VENDOR_BADGE: Record<string, VendorBadgeSpec> = {
  aruba_cx: { short: "Aruba", name: VENDOR_LABEL.aruba_cx, color: VENDOR_COLOR.aruba_cx },
  fs: { short: "FS", name: VENDOR_LABEL.fs, color: VENDOR_COLOR.fs },
  unifi: { short: "UniFi", name: VENDOR_LABEL.unifi, color: VENDOR_COLOR.unifi },
  opnsense: { short: "OPN", name: VENDOR_LABEL.opnsense, color: VENDOR_COLOR.opnsense },
  eaton: { short: "Eaton", name: VENDOR_LABEL.eaton, color: VENDOR_COLOR.eaton },
  hpe_ups: { short: "UPS", name: VENDOR_LABEL.hpe_ups, color: VENDOR_COLOR.hpe_ups },
  hpe_ilo: { short: "iLO", name: VENDOR_LABEL.hpe_ilo, color: VENDOR_COLOR.hpe_ilo },
  generic: { short: "Gen", name: VENDOR_LABEL.generic, color: VENDOR_COLOR.generic },
};

// Badge spec for any vendor key; unknown vendors get a 3-letter uppercase
// abbreviation in the neutral slate color, a missing vendor the generic badge.
export function vendorBadge(vendor: string | null | undefined): VendorBadgeSpec {
  if (!vendor) return VENDOR_BADGE.generic;
  const known = VENDOR_BADGE[vendor];
  if (known) return known;
  const short = vendor.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || VENDOR_BADGE.generic.short;
  return { short, name: vendor, color: PALETTE.slate };
}
