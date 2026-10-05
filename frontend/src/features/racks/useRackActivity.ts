// ── Rack LED activity preference ─────────────────────────────────────────────
// Optional, very subtle blink of "up" port LEDs on rack faceplates. Off by
// default, persisted in localStorage, and unavailable entirely when the user
// prefers reduced motion (the CSS keyframes are additionally guarded in
// index.css).

import { useCallback, useState } from "react";
import { useReducedMotion } from "../topology/motion";

export const RACK_ACTIVITY_STORAGE_KEY = "netmap-rack-activity";

function readStored(): boolean {
  try {
    return window.localStorage.getItem(RACK_ACTIVITY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useRackActivity() {
  const reducedMotion = useReducedMotion();
  const [enabled, setEnabledState] = useState<boolean>(readStored);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      window.localStorage.setItem(RACK_ACTIVITY_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // Storage unavailable (private mode, quota): keep the in-memory value.
    }
  }, []);

  return {
    // Whether the toggle should be offered at all.
    available: !reducedMotion,
    // Stored user preference.
    enabled,
    setEnabled,
    // Effective state passed to the elevation view.
    active: enabled && !reducedMotion,
  };
}
