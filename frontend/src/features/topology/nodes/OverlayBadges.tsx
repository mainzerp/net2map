import { Crown } from "lucide-react";
import type { NodeOverlay } from "../overlays";

// ── OverlayBadges ────────────────────────────────────────────────────────────
// Small pills pinned to the top edge of a device/rack node for the active
// logical layer: "Root" (STP root bridge, visible at every zoom tier) and the
// member port count in the selected VLAN (mid/close tiers via topo-detail).

export default function OverlayBadges({ overlay }: { overlay?: NodeOverlay }) {
  if (!overlay) return null;
  const showVlan = overlay.vlanPorts != null && overlay.vlanPorts > 0;
  if (!overlay.isRoot && !showVlan) return null;
  return (
    <span className="absolute -top-2 right-2 flex items-center gap-1 pointer-events-none">
      {overlay.isRoot && (
        <span
          className="inline-flex items-center gap-0.5 rounded-full border border-overlay-stp bg-overlay-stp-soft px-1.5 text-[9px] leading-[14px] font-semibold text-overlay-stp"
          title="STP root bridge"
          data-testid="stp-root-badge"
        >
          <Crown size={9} strokeWidth={2} aria-hidden="true" />
          Root
        </span>
      )}
      {showVlan && (
        <span
          className="topo-detail rounded-full border border-overlay-vlan bg-overlay-vlan-soft px-1.5 font-mono text-[9px] leading-[14px] font-semibold tabular-nums text-overlay-vlan"
          style={
            overlay.color
              ? { borderColor: overlay.color.stroke, backgroundColor: overlay.color.soft, color: overlay.color.stroke }
              : undefined
          }
          title={`${overlay.vlanPorts} port${overlay.vlanPorts === 1 ? "" : "s"} in this VLAN`}
          data-testid="vlan-port-badge"
        >
          {overlay.vlanPorts}
        </span>
      )}
    </span>
  );
}
