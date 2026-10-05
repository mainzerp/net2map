import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, GitBranch, Layers, Tag, type LucideIcon } from "lucide-react";
import { Button, Input } from "../../components/ui";
import type { FilterState, RackInfo, SwitchClass, TopologyNode } from "../../types";
import type { MapLayer, VlanOption } from "./overlays";
import { vlanColor } from "./vlanColor";

// ── MapToolbar ───────────────────────────────────────────────────────────────
// Search, rack/class filter chips, logical layer control (Off / STP / VLAN),
// auto-layout and zoom-reset actions, plus a
// live "updated Xs ago" staleness indicator. Rendered by TopologyCanvas inside
// the ReactFlow provider so layout actions can reach the flow instance.

interface MapToolbarProps {
  devices: TopologyNode[];
  racks: RackInfo[];
  classes: SwitchClass[];
  filters: FilterState;
  onFilterChange: (updater: FilterState | ((prev: FilterState) => FilterState)) => void;
  onSearchSelect: (device: TopologyNode) => void;
  // Omitted when a floor-plan background is set: nodes are placed by hand on
  // the uploaded map, and a re-layout would discard that arrangement.
  onAutoLayout?: () => void;
  onResetZoom: () => void;
  // Animated flow overlay on active links (persisted by TopologyCanvas).
  flowEnabled?: boolean;
  // When set, the toggle still records the preference but explains why no
  // animation is visible (e.g. prefers-reduced-motion).
  flowDisabledReason?: string;
  onToggleFlow?: () => void;
  // Logical layer (Off / STP / VLAN), persisted by TopologyCanvas. A set
  // *DisabledReason disables that option and becomes its tooltip.
  layer?: MapLayer;
  onLayerChange?: (layer: MapLayer) => void;
  stpDisabledReason?: string;
  vlanDisabledReason?: string;
  vlanOptions?: VlanOption[];
  selectedVlan?: number | null;
  onVlanChange?: (vlan: number) => void;
  stats: { switches: number; fast: number; gig: number };
  updatedAt: number | null;
}

const LAYER_OPTIONS: { value: MapLayer; label: string; title: string; icon: LucideIcon }[] = [
  { value: "off", label: "Off", title: "No logical layer", icon: Layers },
  { value: "stp", label: "STP", title: "Spanning tree: root bridge, root paths and blocked links", icon: GitBranch },
  { value: "vlan", label: "VLAN", title: "Highlight links and devices carrying a VLAN", icon: Tag },
];

function formatAge(updatedAt: number | null, now: number): string {
  if (!updatedAt) return "never";
  const secs = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function MapToolbar({
  devices,
  racks,
  classes,
  filters,
  onFilterChange,
  onSearchSelect,
  onAutoLayout,
  onResetZoom,
  flowEnabled = false,
  flowDisabledReason,
  onToggleFlow,
  layer = "off",
  onLayerChange,
  stpDisabledReason,
  vlanDisabledReason,
  vlanOptions = [],
  selectedVlan = null,
  onVlanChange,
  stats,
  updatedAt,
}: MapToolbarProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLDivElement>(null);
  const selectedVlanColor = selectedVlan != null ? vlanColor(selectedVlan) : null;

  // Tick once per second so the staleness indicator stays live.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Close the search dropdown on outside clicks.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return devices
      .filter(d =>
        (d.sys_name || "").toLowerCase().includes(q) ||
        (d.ip || "").toLowerCase().includes(q) ||
        (d.hostname || "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [devices, query]);

  const selectDevice = (device: TopologyNode) => {
    onSearchSelect(device);
    setQuery("");
    setOpen(false);
  };

  const toggleRack = (rackId: number) => {
    onFilterChange(prev => {
      const current = prev.racks ? new Set(prev.racks) : new Set(racks.map(r => r.id));
      if (current.has(rackId)) current.delete(rackId);
      else current.add(rackId);
      return { ...prev, racks: current.size === racks.length ? null : current.size === 0 ? new Set<number>() : current };
    });
  };
  const toggleClass = (classId: number) => {
    onFilterChange(prev => {
      const current = prev.classes ? new Set(prev.classes) : new Set(classes.map(c => c.id));
      if (current.has(classId)) current.delete(classId);
      else current.add(classId);
      return { ...prev, classes: current.size === classes.length ? null : current.size === 0 ? new Set<number>() : current };
    });
  };
  const clearFilters = () => onFilterChange({ racks: null, classes: null });
  const hasFilters = filters.racks !== null || filters.classes !== null;

  const chipClass = (active: boolean) =>
    `text-[10px] px-2 py-0.5 rounded border transition-colors cursor-pointer select-none ${
      active
        ? "border-accent text-accent bg-panel-2"
        : "border-line text-muted bg-panel hover:text-primary"
    }`;

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-line bg-surface flex-wrap">
      {/* Live stats */}
      <div className="flex items-center gap-3 text-[11px] text-muted shrink-0">
        <span><span className="text-success">|</span> {stats.switches} Switches</span>
        <span><span className="text-accent">|</span> {stats.fast} x {">="}10G</span>
        <span><span className="text-muted">|</span> {stats.gig} x 1G</span>
      </div>

      {/* Search */}
      <div ref={searchRef} className="relative w-full sm:w-56">
        <Input
          value={query}
          placeholder="Search device (name / ip)..."
          aria-label="Search device"
          onChange={e => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            if (e.key === "Enter" && matches.length > 0) selectDevice(matches[0]);
            if (e.key === "Escape") {
              setQuery("");
              setOpen(false);
            }
          }}
        />
        {open && query.trim() && matches.length === 0 && (
          <div role="status" className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted shadow-lg">
            No matching devices
          </div>
        )}
        {open && matches.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border border-line bg-panel shadow-lg overflow-hidden">
            {matches.map(d => (
              <button
                key={d.id}
                type="button"
                onClick={() => selectDevice(d)}
                className="w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-panel-2 cursor-pointer flex items-center gap-2"
              >
                <span className="text-primary font-semibold truncate">{d.sys_name || d.ip}</span>
                <span className="text-muted font-mono text-[10px] ml-auto shrink-0">{d.ip}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Filter chips */}
      {racks.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] text-muted tracking-widest">RACKS</span>
          {racks.map(r => {
            const active = !filters.racks || filters.racks.has(r.id);
            return (
              <button key={r.id} type="button" aria-pressed={active} onClick={() => toggleRack(r.id)} className={chipClass(active)}>
                {r.label}
              </button>
            );
          })}
        </div>
      )}
      {classes.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] text-muted tracking-widest">CLASSES</span>
          {classes.map(c => {
            const active = !filters.classes || filters.classes.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={active}
                onClick={() => toggleClass(c.id)}
                className={chipClass(active)}
                style={active ? { borderColor: c.color, color: c.color } : undefined}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle"
                  style={{ backgroundColor: c.color, opacity: active ? 1 : 0.3 }}
                />
                {c.label}
              </button>
            );
          })}
        </div>
      )}
      {hasFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="text-[9px] px-2 py-0.5 rounded border border-danger text-danger hover:bg-danger-soft transition-colors cursor-pointer"
        >
          Clear filters
        </button>
      )}

      {/* Actions + staleness */}
      <div className="ml-auto flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-muted tabular-nums" title="Topology data freshness">
          updated {formatAge(updatedAt, now)}
        </span>
        {onLayerChange && (
          <div className="flex items-center gap-1.5">
            <div
              role="group"
              aria-label="Map layer"
              className="inline-flex items-center rounded border border-line bg-panel overflow-hidden"
            >
              {LAYER_OPTIONS.map(opt => {
                const reason = opt.value === "stp" ? stpDisabledReason : opt.value === "vlan" ? vlanDisabledReason : undefined;
                const disabled = !!reason;
                const active = layer === opt.value;
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    aria-disabled={disabled || undefined}
                    title={reason ?? opt.title}
                    onClick={() => {
                      if (!disabled && !active) onLayerChange(opt.value);
                    }}
                    className={`text-[10px] px-2 py-0.5 inline-flex items-center gap-1 select-none transition-colors border-l border-line first:border-l-0 ${
                      disabled
                        ? "text-muted opacity-50 cursor-not-allowed"
                        : active
                          ? "text-accent bg-panel-2 cursor-pointer"
                          : "text-muted hover:text-primary cursor-pointer"
                    }`}
                  >
                    <Icon size={11} strokeWidth={1.75} aria-hidden="true" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {layer === "vlan" && vlanOptions.length > 0 && (
              <span className="inline-flex items-center gap-1">
                {selectedVlanColor && (
                  <span
                    aria-hidden="true"
                    data-testid="vlan-color-swatch"
                    className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: selectedVlanColor.stroke }}
                  />
                )}
                <select
                  aria-label="VLAN"
                  value={selectedVlan ?? ""}
                  onChange={e => onVlanChange?.(Number(e.target.value))}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-overlay-vlan bg-panel text-primary max-w-40 cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  style={selectedVlanColor ? { borderColor: selectedVlanColor.stroke } : undefined}
                >
                  {vlanOptions.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </span>
            )}
          </div>
        )}
        {onToggleFlow && (
          <button
            type="button"
            aria-pressed={flowEnabled}
            onClick={onToggleFlow}
            title={flowDisabledReason ?? "Animate traffic flow on active links"}
            className={`${chipClass(flowEnabled)} inline-flex items-center gap-1`}
          >
            <Activity size={11} strokeWidth={1.75} aria-hidden="true" />
            Flow
          </button>
        )}
        {onAutoLayout && (
          <Button size="sm" variant="secondary" onClick={onAutoLayout} title="Re-layout all nodes and persist positions">
            Auto-Layout
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onResetZoom} title="Reset zoom and pan">
          Reset Zoom
        </Button>
      </div>
    </div>
  );
}
