import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const ROUTE_MAP: Record<string, string> = {
  "1": "/",
  "2": "/map",
  "3": "/devices",
  "4": "/network",
  "5": "/logs",
  "6": "/settings",
  "7": "/racks",
};

export interface KeyboardShortcutOptions {
  onEscape?: () => void;
  onScan?: () => void;
}

export function useKeyboardShortcuts(opts: KeyboardShortcutOptions = {}) {
  const navigate = useNavigate();

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el?.isContentEditable) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // Skip when focus is inside a modal/dialog
      if (el?.closest('[role="dialog"], dialog, [data-modal]')) return;

      if (e.key === "Escape") {
        opts.onEscape?.();
        return;
      }

      if (e.key === "s" || e.key === "S") {
        opts.onScan?.();
        return;
      }

      const route = ROUTE_MAP[e.key];
      if (route) {
        navigate(route);
      }
    }

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [navigate, opts]);
}
