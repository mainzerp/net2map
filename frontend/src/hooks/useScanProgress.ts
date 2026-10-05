import { useState, useEffect, useRef } from "react";
import { API, api } from "../api";
import { useToast } from "../components/ToastProvider";
import type { ScanProgress } from "../types";

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = 30000;

// Derive the WebSocket base URL from VITE_API_URL when set (remote backend),
// otherwise fall back to the page origin (Vite proxy / nginx).
function wsBaseUrl(): string {
  if (API) {
    try {
      const u = new URL(API);
      return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`;
    } catch {
      // malformed VITE_API_URL -- fall through to page origin
    }
  }
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

export function useScanProgress(jobId: string | null): ScanProgress | null {
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { addToast } = useToast();
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;

  useEffect(() => {
    if (!jobId) {
      setProgress(null);
      return;
    }

    let unmounted = false;
    let attempts = 0;
    let failureNotified = false;

    function notifyFailure(message: string) {
      if (failureNotified) return;
      failureNotified = true;
      addToastRef.current(message, "error");
    }

    async function connect() {
      if (unmounted) return;

      let ticket = "";
      try {
        const resp = await api.post<{ ticket?: string }>("/api/auth/ws-ticket", {});
        ticket = resp.ticket || "";
      } catch (ex) {
        // No silent token fallback: a raw JWT in the URL would end up in proxy logs.
        notifyFailure(`Live scan progress unavailable: ${ex instanceof Error ? ex.message : String(ex)}`);
        return;
      }
      // The ticket request may resolve after unmount -- do not leak a WebSocket.
      if (unmounted) return;

      const url = `${wsBaseUrl()}/ws/scan-progress${ticket ? "?token=" + encodeURIComponent(ticket) : ""}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
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
        attempts += 1;
        if (attempts > MAX_RECONNECT_ATTEMPTS) {
          notifyFailure("Live scan progress connection lost - giving up. Reload to retry.");
          return;
        }
        const delay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** (attempts - 1));
        reconnectRef.current = setTimeout(connect, delay);
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
