// ── Map layer preference ─────────────────────────────────────────────────────
// Persisted logical layer (Off / STP / VLAN / Latency) and the selected VLAN, following
// the flow toggle pattern in flowContext.ts.

import type { MapLayer } from "./overlays";

export const LAYER_STORAGE_KEY = "net2map-map-layer";
export const LAYER_VLAN_STORAGE_KEY = "net2map-map-layer-vlan";

export function loadLayerPreference(): MapLayer {
  try {
    const raw = localStorage.getItem(LAYER_STORAGE_KEY);
    if (raw === "stp" || raw === "vlan" || raw === "latency" || raw === "off") return raw;
  } catch { /* ignore */ }
  return "off";
}

export function saveLayerPreference(layer: MapLayer): void {
  try {
    localStorage.setItem(LAYER_STORAGE_KEY, layer);
  } catch { /* ignore */ }
}

// Stored VLAN id, or null when none was picked yet.
export function loadLayerVlan(): number | null {
  try {
    const raw = localStorage.getItem(LAYER_VLAN_STORAGE_KEY);
    if (raw == null || raw === "") return null;
    const id = Number(raw);
    if (Number.isInteger(id)) return id;
  } catch { /* ignore */ }
  return null;
}

export function saveLayerVlan(vlan: number): void {
  try {
    localStorage.setItem(LAYER_VLAN_STORAGE_KEY, String(vlan));
  } catch { /* ignore */ }
}
