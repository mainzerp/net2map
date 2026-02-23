import { useState, useCallback, useEffect } from "react";
import { api, API } from "../api.js";

export function useMapBackground() {
  const [mapBgUrl, setMapBgUrl] = useState(null);
  const [mapBgNat, setMapBgNat] = useState(null);
  const [mapBgOpacity, setMapBgOpacity] = useState(0.3);
  const [mapBgScale, setMapBgScale] = useState(1);

  const loadMapBg = useCallback(() => {
    fetch(`${API}/api/map-background`, { method: "GET" })
      .then(r => {
        if (r.ok) {
          const url = `${API}/api/map-background?v=${Date.now()}`;
          setMapBgUrl(url);
          const img = new Image();
          img.onload = () => setMapBgNat({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => setMapBgNat(null);
          img.src = url;
        } else {
          setMapBgUrl(null);
          setMapBgNat(null);
        }
      })
      .catch(() => { setMapBgUrl(null); setMapBgNat(null); });
  }, []);

  const loadMapSettings = useCallback(() => {
    api.get("/api/map-settings").then(s => {
      if (s.opacity != null) setMapBgOpacity(s.opacity);
      if (s.scale != null) setMapBgScale(s.scale);
    }).catch(console.error);
  }, []);

  useEffect(() => { loadMapBg(); }, []);
  useEffect(() => { loadMapSettings(); }, []);

  return { mapBgUrl, mapBgNat, mapBgOpacity, mapBgScale };
}
