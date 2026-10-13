import { create } from "zustand";
import { api } from "./api";
import type { Net2MapState, SelectedRack } from "./types";

type FloorKeyValue = number | "unassigned";

export const FLOOR_STORAGE_KEY = "net2map-floor";

export function loadStoredFloor(): FloorKeyValue | null {
  try {
    const raw = localStorage.getItem(FLOOR_STORAGE_KEY);
    if (raw === "unassigned") return "unassigned";
    if (raw && /^\d+$/.test(raw)) return Number(raw);
  } catch { /* ignore */ }
  return null;
}

// Map focus slice ("Show on map" / toolbar search). Kept local to the store
// module so the shared Net2MapState type in types.ts stays untouched.
export interface MapFocusSlice {
  // Device the topology canvas should center on; cleared by the canvas once
  // the viewport animation has been issued.
  focusDeviceId: number | null;
  setFocusDevice: (id: number | null) => void;
  clearFocusDevice: () => void;
}

export type Net2MapStoreState = Net2MapState & MapFocusSlice;

const useNet2MapStore = create<Net2MapStoreState>((set) => ({
  // ── Map focus slice ──────────────────────────────────────────────────────
  focusDeviceId: null,
  setFocusDevice: (id: number | null) => set({ focusDeviceId: id }),
  clearFocusDevice: () => set({ focusDeviceId: null }),

  // ── Topology slice ───────────────────────────────────────────────────────
  // Topology data itself lives in TanStack Query (hooks/api/useTopology.ts);
  // the store only keeps the selection state.
  selectedRack: null,

  setSelectedRack: (rackOrFn: SelectedRack | null | ((prev: SelectedRack | null) => SelectedRack | null)) => {
    set((state) => {
      const next = typeof rackOrFn === "function"
        ? rackOrFn(state.selectedRack)
        : rackOrFn;
      return { selectedRack: next };
    });
  },

  highlightPortKey: null,
  setHighlightPortKey: (key: string | null) => set({ highlightPortKey: key }),
  clearHighlightPortKey: () => set({ highlightPortKey: null }),

  // ── Active floor slice ───────────────────────────────────────────────────
  // The URL param (?floor=) wins over this value; see
  // features/topology/useActiveFloor.ts.
  activeFloor: loadStoredFloor(),
  setActiveFloor: (key: FloorKeyValue | null) => {
    try {
      if (key == null) localStorage.removeItem(FLOOR_STORAGE_KEY);
      else localStorage.setItem(FLOOR_STORAGE_KEY, String(key));
    } catch { /* ignore */ }
    set({ activeFloor: key });
  },

  // ── Scan slice ───────────────────────────────────────────────────────────
  activeScanJobId: null,
  scanStatus: null,

  startScan: async (): Promise<{ job_id: string; status: string }> => {
    try {
      const res = await api.post<{ job_id: string; status: string }>("/api/scan/jobs");
      set({ activeScanJobId: res.job_id, scanStatus: res.status });
      return res;
    } catch (e) {
      set({ scanStatus: "failed" });
      throw e;
    }
  },

  setScanStatus: (status: string | null) => set({ scanStatus: status }),
  clearScanJob: () => set({ activeScanJobId: null, scanStatus: null }),

  // ── Rack orders slice ────────────────────────────────────────────────────
  rackOrders: (() => {
    try { return JSON.parse(localStorage.getItem("net2map_rack_orders") || "{}"); }
    catch { return {}; }
  })(),

  setRackOrders: (ordersOrFn: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>)) => {
    set((state) => {
      const next = typeof ordersOrFn === "function"
        ? ordersOrFn(state.rackOrders)
        : ordersOrFn;
      try { localStorage.setItem("net2map_rack_orders", JSON.stringify(next)); } catch { /* ignore */ }
      return { rackOrders: next };
    });
  },
}));

export default useNet2MapStore;
