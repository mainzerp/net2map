import { useQuery } from "@tanstack/react-query";
import { api, apiUrl, _getAuthHeader } from "../../api";
import useNetmapStore from "../../store";
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
// is probed with a bare fetch; the query data is the image URL versioned via
// the store's bgVersion (bumped on successful upload/delete, so repeat
// refetches reuse the cached image instead of busting it every time).
export function useMapBackground() {
  return useQuery<string | null>({
    queryKey: queryKeys.mapBackground,
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/map-background"), { headers: _getAuthHeader() });
      if (!res.ok) return null;
      return `${apiUrl("/api/map-background")}?v=${useNetmapStore.getState().bgVersion}`;
    },
  });
}
