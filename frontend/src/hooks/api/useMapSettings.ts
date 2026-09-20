import { useQuery } from "@tanstack/react-query";
import { api, API, _getAuthHeader } from "../../api";
import { queryKeys } from "./keys";

// ── Map appearance settings (MapSettingsTab) ─────────────────────────────────

export interface MapSettings {
  opacity?: number;
  scale?: number;
  bg_color?: string;
  [key: string]: unknown;
}

export function useMapSettings() {
  return useQuery<MapSettings>({
    queryKey: queryKeys.mapSettings,
    queryFn: async () => {
      const data: unknown = await api.get("/api/map-settings");
      return (data ?? {}) as MapSettings;
    },
  });
}

// The background endpoint returns raw image bytes, not JSON, so availability
// is probed with a bare fetch; the query data is the cache-busted image URL.
export function useMapBackground() {
  return useQuery<string | null>({
    queryKey: queryKeys.mapBackground,
    queryFn: async () => {
      const res = await fetch(`${API}/api/map-background`, { headers: _getAuthHeader() });
      if (!res.ok) return null;
      return `${API}/api/map-background?v=${Date.now()}`;
    },
  });
}
