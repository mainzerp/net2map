import { create } from "zustand";
import { api, API, _getAuthHeader } from "./api.js";

const useNetmapStore = create((set, get) => ({
  // ── Topology slice ───────────────────────────────────────────────────────
  topology: { nodes: [], links: [], racks: [], classes: [] },
  selectedRack: null,
  loadError: null,

  loadTopology: async () => {
    try {
      const data = await api.get("/api/topology");
      set({ topology: data, loadError: null });
      return data;
    } catch (e) {
      set({ loadError: e.message || "Failed to load topology" });
      return null;
    }
  },

  setSelectedRack: (rackOrFn) => {
    set((state) => {
      const next = typeof rackOrFn === "function"
        ? rackOrFn(state.selectedRack)
        : rackOrFn;
      try {
        if (next) sessionStorage.setItem("selectedRackId", String(next.id));
        else sessionStorage.removeItem("selectedRackId");
      } catch {}
      return { selectedRack: next };
    });
  },

  restoreSelectedRack: (data) => {
    let savedId;
    try { savedId = sessionStorage.getItem("selectedRackId"); } catch {}
    if (!savedId) return;
    const id = Number(savedId);
    const rack = (data.racks || []).find(r => r.id === id);
    if (rack) {
      const devices = data.nodes.filter(n => n.rack_id === id);
      set({
        selectedRack: {
          id: rack.id,
          label: rack.label,
          location: rack.location || `${rack.label}${rack.room ? " / " + rack.room : ""}`,
          devices,
        },
      });
    } else {
      try { sessionStorage.removeItem("selectedRackId"); } catch {}
    }
  },

  // ── Map background slice ─────────────────────────────────────────────────
  bgUrl: null,
  bgNat: null,
  bgOpacity: 0.3,
  bgScale: 1,
  bgColor: "#020817",

  loadMapBackground: () => {
    fetch(`${API}/api/map-background`, { headers: _getAuthHeader() })
      .then(r => {
        if (!r.ok) throw new Error();
        const url = `${API}/api/map-background?v=${Date.now()}`;
        set({ bgUrl: url });
        const img = new Image();
        img.onload = () => set({ bgNat: { w: img.naturalWidth, h: img.naturalHeight } });
        img.onerror = () => set({ bgNat: null });
        img.src = url;
      })
      .catch(() => { set({ bgUrl: null, bgNat: null }); });
  },

  loadMapSettings: () => {
    api.get("/api/map-settings").then(s => {
      const patch = {};
      if (s.opacity != null) patch.bgOpacity = s.opacity;
      if (s.scale != null) patch.bgScale = s.scale;
      if (s.bg_color != null) patch.bgColor = s.bg_color;
      set(patch);
    }).catch(console.error);
  },

  // ── Scan slice ───────────────────────────────────────────────────────────
  activeScanJobId: null,
  scanStatus: null,

  startScan: async () => {
    try {
      const res = await api.post("/api/scan/jobs");
      set({ activeScanJobId: res.job_id, scanStatus: res.status });
      return res;
    } catch (e) {
      set({ scanStatus: "failed" });
      throw e;
    }
  },

  setScanStatus: (status) => set({ scanStatus: status }),
  clearScanJob: () => set({ activeScanJobId: null, scanStatus: null }),

  // ── Rack orders slice ────────────────────────────────────────────────────
  rackOrders: (() => {
    try { return JSON.parse(localStorage.getItem("netmap_rack_orders") || "{}"); }
    catch { return {}; }
  })(),

  setRackOrders: (ordersOrFn) => {
    set((state) => {
      const next = typeof ordersOrFn === "function"
        ? ordersOrFn(state.rackOrders)
        : ordersOrFn;
      try { localStorage.setItem("netmap_rack_orders", JSON.stringify(next)); } catch {}
      return { rackOrders: next };
    });
  },
}));

export default useNetmapStore;
