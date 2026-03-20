import { useState, useEffect, useRef } from "react";
import { getStoredToken, api } from "../api";
import type { ScanProgress } from "../types";

export function useScanProgress(jobId: string | null): ScanProgress | null {
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!jobId) {
      setProgress(null);
      return;
    }

    let unmounted = false;

    async function connect() {
      if (unmounted) return;

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      let ticket = "";
      try {
        const resp = await api.post("/api/auth/ws-ticket", {});
        ticket = resp.ticket || "";
      } catch (_) {
        // Ticket endpoint unavailable (no Redis or auth disabled) -- fall back to raw token
        ticket = getStoredToken();
      }
      const url = `${proto}//${window.location.host}/ws/scan-progress${ticket ? "?token=" + encodeURIComponent(ticket) : ""}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
      };

      ws.onmessage = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.job_id && data.job_id !== jobId) return;
          setProgress(data);
        } catch (err) {
          console.warn("WebSocket message parse error", err);
        }
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
