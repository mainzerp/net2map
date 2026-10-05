/**
 * Unit tests for the per-VLAN color helper (vlanColor.ts).
 */
import { describe, it, expect } from "vitest";
import { VLAN_HUE_MAX, VLAN_HUE_MIN, vlanColor, vlanHue } from "../features/topology/vlanColor";

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

describe("vlanColor", () => {
  it("is deterministic and built from the theme lightness/chroma tokens", () => {
    expect(vlanColor(20)).toEqual(vlanColor(20));
    const hue = vlanHue(20);
    expect(vlanColor(20)).toEqual({
      stroke: `oklch(var(--vlan-l) var(--vlan-c) ${hue})`,
      soft: `oklch(var(--vlan-soft-l) var(--vlan-soft-c) ${hue})`,
    });
  });

  it("gives common VLAN ids clearly distinct hues", () => {
    const ids = [1, 10, 20, 30, 40, 99, 100, 200];
    const hues = ids.map(vlanHue);
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        expect(hueDistance(hues[i], hues[j]), `VLAN ${ids[i]} vs ${ids[j]}`).toBeGreaterThanOrEqual(18);
      }
    }
    expect(new Set(ids.map(id => vlanColor(id).stroke)).size).toBe(ids.length);
  });

  it("separates consecutive ids", () => {
    for (let id = 1; id < 4094; id++) {
      expect(hueDistance(vlanHue(id), vlanHue(id + 1))).toBeGreaterThanOrEqual(18);
    }
  });

  it("never lands in the excluded terracotta/red band across all VLAN ids", () => {
    for (let id = 1; id <= 4094; id++) {
      const hue = vlanHue(id);
      expect(hue).toBeGreaterThanOrEqual(VLAN_HUE_MIN);
      expect(hue).toBeLessThanOrEqual(VLAN_HUE_MAX);
    }
  });
});
