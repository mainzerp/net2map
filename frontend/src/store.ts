import { create } from "zustand";
import { api, API, _getAuthHeader } from "./api";
import type { NetmapState, SelectedRack } from "./types";

const useNetmapStore = create<NetmapState>((set) => ({
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
  bgColor: "#020817",

  loadMapBackground: () => {
    // Single existence check (aborted before the body downloads), then one
    // real load via Image which also yields the natural dimensions.
    fetch(`${API}/api/map-background`, { headers: _getAuthHeader() })
      .then(r => {
        if (!r.ok) throw new Error();
        r.body?.cancel().catch(() => {});
        const url = `${API}/api/map-background?v=${Date.now()}`;
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
    api.get("/api/map-settings").then((s: Record<string, unknown>) => {
      const patch: Partial<NetmapState> = {};
      if (s.opacity != null) patch.bgOpacity = s.opacity as number;
      if (s.scale != null) patch.bgScale = s.scale as number;
      if (s.bg_color != null) patch.bgColor = s.bg_color as string;
      set(patch);
    }).catch(console.error);
  },

  // ── Scan slice ───────────────────────────────────────────────────────────
  activeScanJobId: null,
  scanStatus: null,

  startScan: async (): Promise<{ job_id: string; status: string }> => {
    try {
      const res = await api.post("/api/scan/jobs");
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
