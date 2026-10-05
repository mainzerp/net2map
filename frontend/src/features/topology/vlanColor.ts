// ── Per-VLAN colors ──────────────────────────────────────────────────────────
// Every VLAN id gets a stable hue; lightness and chroma come from theme tokens
// (--vlan-l / --vlan-c for strokes and text, --vlan-soft-l / --vlan-soft-c for
// chip backgrounds, see index.css), so the same string works in both themes
// without any JS theme detection.
//
// Hue: id * HUE_STEP (mod 360), then compressed linearly into the allowed arc
// [HUE_MIN, HUE_MAX]. The excluded arc 350..60 deg (OKLCH) covers --danger
// (hue 18-22) and the terracotta selection accent (hue 35-41) with >= 19 deg
// margin on both sides, so a VLAN never reads as "blocked" or "selected".
//
// HUE_STEP is 360 * (sqrt(19) - 5) / 10 (about -23.08 deg) instead of the
// golden angle: both are badly approximable irrationals (no periodic
// collisions over 1..4094), but the golden angle collides at Fibonacci gaps
// that are common VLAN pairs (10 vs 99 land 1.5 deg apart, 1 vs 200 3.3 deg).
// This step keeps ids 1..12, 10..100 by tens and 1/10/20/30/40/99/100/200
// at least 18.6 deg apart after compression.
//
// Lightness/chroma per theme were chosen so every allowed hue stays inside
// the sRGB gamut and reaches >= 4.5:1 on --surface and --panel (also as text
// on the matching soft background).

export interface VlanColor {
  stroke: string;
  soft: string;
}

export const VLAN_HUE_MIN = 60;
export const VLAN_HUE_MAX = 350;
const HUE_SPAN = VLAN_HUE_MAX - VLAN_HUE_MIN;
const HUE_STEP = (360 * (Math.sqrt(19) - 5)) / 10;

export function vlanHue(id: number): number {
  const raw = (((id * HUE_STEP) % 360) + 360) % 360;
  return Math.round((VLAN_HUE_MIN + (raw / 360) * HUE_SPAN) * 10) / 10;
}

export function vlanColor(id: number): VlanColor {
  const hue = vlanHue(id);
  return {
    stroke: `oklch(var(--vlan-l) var(--vlan-c) ${hue})`,
    soft: `oklch(var(--vlan-soft-l) var(--vlan-soft-c) ${hue})`,
  };
}
