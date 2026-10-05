// ── ScanOverlay ──────────────────────────────────────────────────────────────
// Quiet "survey in progress" layer over the canvas while a scan runs: a thin
// terracotta progress rule along the top edge plus a slow, low-opacity radial
// pulse centered on the viewport. Pure CSS animation (.topo-scan-* in
// index.css); under prefers-reduced-motion only the static rule remains.
// pointer-events are disabled so the map stays fully interactive.

interface ScanOverlayProps {
  // Scanned fraction 0..1, or null while the total is unknown (indeterminate).
  progress: number | null;
  label?: string;
}

export default function ScanOverlay({ progress, label }: ScanOverlayProps) {
  const determinate = progress != null && Number.isFinite(progress);
  const clamped = determinate ? Math.min(1, Math.max(0, progress as number)) : 0;
  return (
    <div className="topo-scan-overlay pointer-events-none absolute inset-0 overflow-hidden" data-testid="scan-overlay">
      <div className="topo-scan-sweep" aria-hidden="true" />
      <div className="topo-scan-track" aria-hidden="true">
        {determinate ? (
          <div className="topo-scan-line" style={{ transform: `scaleX(${clamped})` }} />
        ) : (
          <div className="topo-scan-line topo-scan-line-indeterminate" />
        )}
      </div>
      <span className="sr-only" role="status">
        {label || "Scan in progress"}
      </span>
    </div>
  );
}
