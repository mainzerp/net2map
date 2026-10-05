// ── Reduced-motion helpers ───────────────────────────────────────────────────
// Viewport animations (setCenter/fitView durations) and the flow overlay
// respect prefers-reduced-motion. CSS animations are additionally guarded in
// index.css, so these helpers only cover the JS-driven parts. The
// implementation lives in the shared hooks module.

export { prefersReducedMotion, useReducedMotion } from "../../hooks/useReducedMotion";
