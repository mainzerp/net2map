import { useEffect, useRef } from "react";
import useNetmapStore from "../store.js";

export function useMapBackground() {
  const mapBgUrl = useNetmapStore(s => s.bgUrl);
  const mapBgNat = useNetmapStore(s => s.bgNat);
  const mapBgOpacity = useNetmapStore(s => s.bgOpacity);
  const mapBgScale = useNetmapStore(s => s.bgScale);
  const mapBgColor = useNetmapStore(s => s.bgColor);
  const loadMapBg = useNetmapStore(s => s.loadMapBackground);
  const loadMapSettings = useNetmapStore(s => s.loadMapSettings);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    loadMapBg();
    loadMapSettings();
  }, [loadMapBg, loadMapSettings]);

  return { mapBgUrl, mapBgNat, mapBgOpacity, mapBgScale, mapBgColor };
}
