import { useEffect, useState } from "react";
import { apiUrl } from "../api";
import type { Floor } from "../types";
import { resolveMapBgColor } from "../theme/mapBackground";

// Public floor background endpoint (no auth, so a plain <img src> works);
// bg_version busts the browser cache after every upload/delete.
export function floorBackgroundUrl(floor: Pick<Floor, "id" | "bg_version">): string {
  return `${apiUrl(`/api/floors/${floor.id}/background`)}?v=${floor.bg_version}`;
}

// Background of the active floor (null floor = no background, theme surface).
// The natural image size is measured once per URL via Image.
export function useMapBackground(floor: Floor | null) {
  const mapBgUrl = floor?.has_background ? floorBackgroundUrl(floor) : null;
  const [measured, setMeasured] = useState<{ url: string; w: number; h: number } | null>(null);

  useEffect(() => {
    if (!mapBgUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setMeasured({ url: mapBgUrl, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = mapBgUrl;
    return () => {
      cancelled = true;
      img.onload = null;
    };
  }, [mapBgUrl]);

  return {
    mapBgUrl,
    mapBgNat: measured && measured.url === mapBgUrl ? { w: measured.w, h: measured.h } : null,
    mapBgOpacity: floor?.bg_opacity ?? 0.3,
    mapBgScale: floor?.bg_scale ?? 1,
    mapBgColor: resolveMapBgColor(floor?.bg_color),
  };
}
