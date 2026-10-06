import { useEffect, useRef } from "react";
import useNet2MapStore from "../store";

export function useMapBackground() {
  const mapBgUrl = useNet2MapStore(s => s.bgUrl);
  const mapBgNat = useNet2MapStore(s => s.bgNat);
  const mapBgOpacity = useNet2MapStore(s => s.bgOpacity);
  const mapBgScale = useNet2MapStore(s => s.bgScale);
  const mapBgColor = useNet2MapStore(s => s.bgColor);
  const loadMapBg = useNet2MapStore(s => s.loadMapBackground);
  const loadMapSettings = useNet2MapStore(s => s.loadMapSettings);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    loadMapBg();
    loadMapSettings();
  }, [loadMapBg, loadMapSettings]);

  return { mapBgUrl, mapBgNat, mapBgOpacity, mapBgScale, mapBgColor };
}
