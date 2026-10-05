import { create } from "zustand";
import { api, apiUrl, _getAuthHeader } from "./api";
import type { NetmapState, SelectedRack } from "./types";
import { resolveMapBgColor } from "./theme/mapBackground";

// Map focus slice ("Show on map" / toolbar search). Kept local to the store
// module so the shared NetmapState type in types.ts stays untouched.
export interface MapFocusSlice {
  // Device the topology canvas should center on; cleared by the canvas once
  // the viewport animation has been issued.
  focusDeviceId: number | null;
  setFocusDevice: (id: number | null) => void;
  clearFocusDevice: () => void;
}

export type NetmapStoreState = NetmapState & MapFocusSlice;

const useNetmapStore = create<NetmapStoreState>((set, get) => ({
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

  // ── Map background slice ─────────────────────────────────────────────────
  bgUrl: null,
  bgNat: null,
  bgOpacity: 0.3,
  bgScale: 1,
  // Empty string = follow the theme surface (see theme/mapBackground.ts).
  bgColor: "",
  // Session-scoped image version: repeat mounts reuse the cached image, and
  // upload/delete mutations bump it so the new URL bypasses the cache.
  bgVersion: Date.now(),

  bumpMapBackgroundVersion: () => set(s => ({ bgVersion: s.bgVersion + 1 })),

  loadMapBackground: () => {
    // Single existence check (aborted before the body downloads), then one
    // real load via Image which also yields the natural dimensions.
    fetch(apiUrl("/api/map-background"), { headers: _getAuthHeader() })
      .then(r => {
        if (!r.ok) throw new Error();
        r.body?.cancel().catch(() => {});
        const url = `${apiUrl("/api/map-background")}?v=${get().bgVersion}`;
        const img = new Image();
        img.onload = () => set({ bgUrl: url, bgNat: { w: img.naturalWidth, h: img.naturalHeight } });
        // On decode/load failure clear bgUrl too, otherwise the grid falls away
        // while no image renders in its place.
        img.onerror = () => set({ bgUrl: null, bgNat: null });
        img.src = url;
      })
      .catch(() => { set({ bgUrl: null, bgNat: null }); });
  },

  loadMapSettings: () => {
    api.get<Record<string, unknown>>("/api/map-settings").then((s) => {
      const patch: Partial<NetmapState> = {};
      if (s.opacity != null) patch.bgOpacity = s.opacity as number;
      if (s.scale != null) patch.bgScale = s.scale as number;
      if (s.bg_color != null) patch.bgColor = resolveMapBgColor(s.bg_color as string);
      set(patch);
    }).catch(console.error);
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
    try { return JSON.parse(localStorage.getItem("netmap_rack_orders") || "{}"); }
    catch { return {}; }
  })(),

  setRackOrders: (ordersOrFn: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>)) => {
    set((state) => {
      const next = typeof ordersOrFn === "function"
        ? ordersOrFn(state.rackOrders)
        : ordersOrFn;
      try { localStorage.setItem("netmap_rack_orders", JSON.stringify(next)); } catch { /* ignore */ }
      return { rackOrders: next };
    });
  },
}));

export default useNetmapStore;
