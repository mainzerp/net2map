import type { ReactNode } from "react";
import { Ban, Crown } from "lucide-react";
import type { MapLayer } from "./overlays";
import { vlanColor } from "./vlanColor";

// ── MapLayerLegend ───────────────────────────────────────────────────────────
// Floating key for the active logical layer, pinned to the top-left corner of
// the canvas (clear of the React Flow controls bottom-left and the minimap
// bottom-right). Rendered only while a layer is active.

interface MapLayerLegendProps {
  layer: MapLayer;
  // Selected VLAN id; colors the samples (falls back to --overlay-vlan).
  vlanId?: number | null;
  vlanLabel?: string | null;
  stpDomains?: number;
}

function Swatch({ color, dash, faded, arrow }: { color: string; dash?: string; faded?: boolean; arrow?: boolean }) {
  return (
    <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true" className="shrink-0">
      <line
        x1="1"
        y1="4"
        x2={arrow ? 19 : 25}
        y2="4"
        style={{ stroke: color }}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={dash}
        strokeOpacity={faded ? 0.25 : 1}
      />
      {arrow && <path d="M18,0.5 L25,4 L18,7.5 z" style={{ fill: color }} />}
    </svg>
  );
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="w-[26px] flex justify-center shrink-0">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

export default function MapLayerLegend({ layer, vlanId, vlanLabel, stpDomains = 0 }: MapLayerLegendProps) {
  if (layer === "off") return null;
  const color = vlanId != null ? vlanColor(vlanId) : null;
  const vlanStroke = color?.stroke ?? "var(--overlay-vlan)";
  const vlanSoft = color?.soft ?? "var(--overlay-vlan-soft)";
  return (
    <aside
      className="absolute top-3 left-3 z-[5] w-52 bg-panel border border-line rounded-card shadow-card px-3 py-2.5 text-[10px] text-muted"
      aria-label="Map layer legend"
      data-testid="map-layer-legend"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-primary mb-1.5 truncate">
        {layer === "vlan" ? `VLAN ${vlanLabel ?? ""}`.trim() : "Spanning tree"}
      </div>
      {layer === "vlan" ? (
        <ul className="flex flex-col gap-1">
          <Row icon={<Swatch color={vlanStroke} />}>Carries VLAN tagged</Row>
          <Row
            icon={
              <span
                className="rounded-sm px-[3px] font-mono font-semibold text-[9px] leading-[13px]"
                style={{ backgroundColor: vlanSoft, color: vlanStroke }}
              >
                U
              </span>
            }
          >
            Untagged (native) only
          </Row>
          <Row icon={<Swatch color="var(--line-strong)" faded />}>Not in this VLAN</Row>
          <Row
            icon={
              <span
                className="rounded-full border px-1.5 font-mono font-semibold text-[9px] leading-[13px]"
                style={{ borderColor: vlanStroke, backgroundColor: vlanSoft, color: vlanStroke }}
              >
                n
              </span>
            }
          >
            Member ports on node
          </Row>
        </ul>
      ) : (
        <ul className="flex flex-col gap-1">
          <Row icon={<Crown size={11} strokeWidth={2} className="text-overlay-stp" aria-hidden="true" />}>Root bridge</Row>
          <Row icon={<Swatch color="var(--overlay-stp)" arrow />}>Root path, arrow toward root</Row>
          <Row icon={<Swatch color="var(--danger)" dash="5 4" />}>
            <span className="inline-flex items-center gap-1">
              Blocked <Ban size={9} strokeWidth={2} className="text-danger" aria-hidden="true" />
            </span>
          </Row>
          <Row icon={<Swatch color="var(--line-strong)" faded />}>Forwarding / no STP data</Row>
        </ul>
      )}
      {layer === "stp" && stpDomains > 1 && (
        <div className="mt-2 pt-1.5 border-t border-line text-warning font-semibold" role="note">
          {stpDomains} STP domains
        </div>
      )}
    </aside>
  );
}
