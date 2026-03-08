import { useState, useEffect, useRef } from "react";
import { getStoredToken } from "../api.js";

export function useScanProgress(jobId) {
  const [progress, setProgress] = useState(null);
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);

  useEffect(() => {
    if (!jobId) {
      setProgress(null);
      return;
    }

    let unmounted = false;

    function connect() {
      if (unmounted) return;

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const token = getStoredToken();
      const url = `${proto}//${window.location.host}/ws/scan-progress${token ? "?token=" + encodeURIComponent(token) : ""}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.job_id && data.job_id !== jobId) return;
          setProgress(data);
        } catch {}
      };

      ws.onclose = () => {
        if (unmounted) return;
        reconnectRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      unmounted = true;
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [jobId]);

  return progress;
}
