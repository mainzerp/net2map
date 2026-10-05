// ── Semantic zoom ────────────────────────────────────────────────────────────
// The canvas exposes one coarse zoom tier instead of the raw zoom factor so
// nodes and edges only react when the tier changes, not on every wheel tick.
//  - far:   compact nodes (label only), edge labels hidden
//  - mid:   regular detail
//  - close: device nodes add a mini port strip
// Most of the tier styling is plain CSS keyed off data-zoom-tier on the
// canvas wrapper (see the topology block at the end of index.css).

import { createContext, useContext } from "react";

export type ZoomTier = "far" | "mid" | "close";

export const ZOOM_TIER_FAR_BELOW = 0.5;
export const ZOOM_TIER_CLOSE_ABOVE = 1.1;

export function zoomTier(zoom: number): ZoomTier {
  if (!Number.isFinite(zoom) || zoom < ZOOM_TIER_FAR_BELOW) return "far";
  if (zoom > ZOOM_TIER_CLOSE_ABOVE) return "close";
  return "mid";
}

export const ZoomTierContext = createContext<ZoomTier>("mid");

export function useZoomTier(): ZoomTier {
  return useContext(ZoomTierContext);
}

// IPs touched by the running scan (latest_ip from scan progress). Nodes that
// contain one of them draw a short-lived accent ring.
export const ScanPulseContext = createContext<ReadonlySet<string>>(new Set());

export function useScanPulse(): ReadonlySet<string> {
  return useContext(ScanPulseContext);
}
