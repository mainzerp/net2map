// ── Link flow animation toggle ───────────────────────────────────────────────
// Persisted user preference for the animated dash overlay on active links.
// The overlay itself is pure CSS (.topo-edge-flow); this module only decides
// whether edges mount the overlay path at all.

import { createContext, useContext } from "react";

export const FLOW_STORAGE_KEY = "net2map-map-flow";

// Above this many edges the overlay defaults to off to keep large maps light.
export const FLOW_DEFAULT_EDGE_LIMIT = 300;

// Stored preference, or null when the user never toggled it.
export function loadFlowPreference(): boolean | null {
  try {
    const raw = localStorage.getItem(FLOW_STORAGE_KEY);
    if (raw === "on") return true;
    if (raw === "off") return false;
  } catch { /* ignore */ }
  return null;
}

export function saveFlowPreference(enabled: boolean): void {
  try {
    localStorage.setItem(FLOW_STORAGE_KEY, enabled ? "on" : "off");
  } catch { /* ignore */ }
}

// Effective default: explicit preference wins, otherwise on for small maps.
export function defaultFlowEnabled(stored: boolean | null, edgeCount: number): boolean {
  if (stored !== null) return stored;
  return edgeCount <= FLOW_DEFAULT_EDGE_LIMIT;
}

export const FlowEnabledContext = createContext<boolean>(false);

export function useFlowEnabled(): boolean {
  return useContext(FlowEnabledContext);
}
