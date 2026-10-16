// ── RackElevation ────────────────────────────────────────────────────────────
// True rack-elevation view drawn as a technical illustration of a 19" rack:
// square-hole side rails with U numbers (U1 at the bottom), blanking plates in
// empty slots, device faceplates with rack ears, a status LED and stylized port
// tiles (filled = up in the speed color, hollow = down, dot = endpoints), a
// label column right of the rack (device name + model as plan annotations with
// leader lines), a port legend, pointer-based drag-and-drop placement and an
// unassigned tray.
// Front and rear faces are drawn side by side on the same U scale; each
// object renders on its own face, and full-depth objects additionally render
// as a hatched, non-draggable "shadow" on the opposite face. An item palette
// above the tray creates rack items by dragging them onto either face.
// Faceplate styling lives in the "Rack faceplates (phase 4)" block of
// index.css; all colors come from theme tokens or theme/visual.ts.

import { deviceDisplayName } from "../../utils/deviceSearch";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { GripVertical, Layers, X } from "lucide-react";
import { speedColor } from "../../theme/visual";
import { Badge, StatusDot } from "../../components/ui";
import VendorBadge from "../../components/map/VendorBadge";
import { useCreateRackItem, useRackItems, useUpdateRackItem } from "../../hooks/api";
import { extractErrorMessage } from "../../api";
import { useToast } from "../../components/ToastProvider";
import type { PortInfo, RackInfo, RackItem, RackItemKind, RackSide, SwitchClass, TopologyNode } from "../../types";
import {
  HEALTH_STATUS_LABEL,
  clampPercent,
  deviceTypeOf,
  formatRuntime,
  healthOf,
  healthStatusBg,
  isPowerOrServer,
} from "../../utils/deviceHealth";
import {
  RACK_SIDES,
  U_PX,
  deviceUHeight,
  fullDepthOf,
  itemBlocks,
  oppositeSide,
  placementValid,
  placementsFromNodes,
  rackHeightU,
  rowFromTop,
  sideOf,
  topmostFreeU,
  usedUnits,
  type DropTarget,
} from "./rackLayout";
import RackItemDialog, { RACK_ITEM_KINDS, rackItemDefaultU, rackItemKindLabel } from "./RackItemDialog";
import {
  activityTiming,
  layoutPortSockets,
  portSpeedMbps,
  portStatus,
  portTitle,
  type SocketGroup,
} from "./portSockets";
import {
  dragPayloadKey,
  useRackDrag,
  useRackLayout,
  type RackBodyRefs,
  type RackDragPayload,
  type RackDragSource,
} from "./useRackLayout";
import { useInspector } from "../../hooks/useInspector";

interface RackElevationProps {
  rack: RackInfo;
  nodes: TopologyNode[];
  readOnly?: boolean;
  // Subtle LED blink on up ports (user toggle, off under reduced motion).
  activity?: boolean;
  // Switch classes from the topology payload; a device with a class gets a
  // thin stripe in the class color on its faceplate.
  classes?: SwitchClass[];
}

function portKeyOf(p: PortInfo, i: number): string {
  return String(p.id ?? p.if_index ?? p.port_id ?? i);
}

// Inline blink timing for an up tile; undefined when activity is off.
function blinkStyle(activity: boolean, seed: number, index: number): React.CSSProperties | undefined {
  if (!activity) return undefined;
  const { delay, duration } = activityTiming(seed, index);
  return { animationDelay: `-${delay}s`, animationDuration: `${duration}s` };
}

// ── Port tile (stylized port) ───────────────────────────────────────────────
// One solid tile per port: filled with the speed color when up, hollow when
// down, a centered dot when endpoints are present, wider for uplinks. Shared
// by the faceplate port block and the legend so both always look identical.
type TileProps = {
  // Speed color for an up tile; null draws the hollow "down" tile.
  color: string | null;
  endpoints?: boolean;
  uplink?: boolean;
  compact?: boolean;
  blink?: boolean;
  style?: React.CSSProperties;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "color" | "style">;

function PortTile({ color, endpoints = false, uplink = false, compact = false, blink = false, style, ...rest }: TileProps) {
  const up = color != null;
  const cls = [
    "rack-tile",
    up ? "rack-tile-up" : "rack-tile-down",
    uplink ? "rack-tile-uplink" : "",
    compact ? "rack-tile-compact" : "",
    blink ? "rack-tile-blink" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const colorStyle = up
    ? ({ backgroundColor: color, "--tile-color": color } as React.CSSProperties)
    : undefined;
  return (
    <span {...rest} className={cls} style={{ ...colorStyle, ...style }}>
      {endpoints && !compact && <span data-testid="port-endpoint-marker" className="rack-tile-endpoint" />}
    </span>
  );
}

function Socket({
  port,
  index,
  uplink,
  activity,
  seed,
}: {
  port: PortInfo;
  index: number;
  uplink: boolean;
  activity: boolean;
  seed: number;
}) {
  const status = portStatus(port);
  const up = status === "up";
  const endpoints = Number(port.endpoint_count || 0);
  const blink = up && activity;
  return (
    <PortTile
      data-testid="port-tile"
      data-status={status}
      data-uplink={uplink ? "1" : "0"}
      data-endpoints={endpoints}
      title={portTitle(port)}
      color={up ? speedColor(portSpeedMbps(port)) : null}
      endpoints={endpoints > 0}
      uplink={uplink}
      blink={blink}
      style={blinkStyle(blink, seed, index)}
    />
  );
}

// ── Port legend under the rack ──────────────────────────────────────────────
const LEGEND_SPEEDS: { label: string; mbps: number }[] = [
  { label: "<1G", mbps: 100 },
  { label: "1G", mbps: 1000 },
  { label: "10G", mbps: 10000 },
  { label: "25G+", mbps: 25000 },
];

function PortLegend() {
  return (
    <div data-testid="rack-port-legend" className="rack-legend" aria-label="Port legend">
      {LEGEND_SPEEDS.map((s) => (
        <span key={s.label} className="rack-legend-item">
          <PortTile color={speedColor(s.mbps)} aria-hidden="true" />
          {s.label}
        </span>
      ))}
      <span className="rack-legend-item">
        <PortTile color={null} aria-hidden="true" />
        down
      </span>
      <span className="rack-legend-item">
        <PortTile color={speedColor(1000)} endpoints aria-hidden="true" />
        endpoints
      </span>
      <span className="rack-legend-item">
        <PortTile color={speedColor(10000)} uplink aria-hidden="true" />
        uplink
      </span>
    </div>
  );
}

function SocketRows({
  group,
  uplink,
  activity,
  seed,
  offset,
}: {
  group: SocketGroup;
  uplink: boolean;
  activity: boolean;
  seed: number;
  offset: number;
}) {
  if (group.top.length === 0 && group.bottom.length === 0) return null;
  const row = (ports: PortInfo[], base: number) => (
    <div className="flex gap-px">
      {ports.map((p, i) => (
        <Socket
          key={portKeyOf(p, base + i)}
          port={p}
          index={base + i}
          uplink={uplink}
          activity={activity}
          seed={seed}
        />
      ))}
    </div>
  );
  return (
    <div
      className={`flex flex-col gap-px shrink-0 ${uplink ? "rack-uplink-group" : ""}`}
      data-testid={uplink ? "uplink-group" : "access-group"}
    >
      {row(group.top, offset)}
      {group.bottom.length > 0 && row(group.bottom, offset + group.top.length)}
    </div>
  );
}

// ── Port block (memoized per device) ────────────────────────────────────────
// Re-renders only when the device's port list, total_ports or the activity
// flag change, not on every drag pointermove of the parent elevation.
const PortBlock = memo(function PortBlock({
  deviceId,
  ports,
  totalPorts,
  activity,
}: {
  deviceId: number;
  ports: PortInfo[];
  totalPorts: number;
  activity: boolean;
}) {
  const layout = useMemo(() => layoutPortSockets(ports, totalPorts), [ports, totalPorts]);
  if (layout.ports.length === 0) return <div className="flex-1 min-w-0" />;

  if (layout.compact) {
    // Compact mode for very large devices: small 6px solid tiles, no uplink
    // grouping and no endpoint marker.
    return (
      <div
        data-testid="port-block"
        data-mode="compact"
        className="flex flex-wrap content-center gap-px p-px overflow-hidden max-h-full flex-1 min-w-0"
      >
        {layout.ports.map((p, i) => {
          const status = portStatus(p);
          const up = status === "up";
          const blink = up && activity;
          return (
            <PortTile
              key={portKeyOf(p, i)}
              data-testid="port-tile"
              data-status={status}
              data-uplink="0"
              data-endpoints={Number(p.endpoint_count || 0)}
              title={portTitle(p)}
              color={up ? speedColor(portSpeedMbps(p)) : null}
              compact
              blink={blink}
              style={blinkStyle(blink, deviceId, i)}
            />
          );
        })}
      </div>
    );
  }

  const accessCount = layout.access.top.length + layout.access.bottom.length;
  // Horizontal padding only: two rows of 10px tiles plus a 1px gap (21px)
  // must fit the 22px content height of a 1U plate (26px - 2px inset - 2px
  // border).
  return (
    <div
      data-testid="port-block"
      data-mode={layout.twoRow ? "two-row" : "one-row"}
      className="flex items-center gap-1 px-px overflow-hidden max-h-full flex-1 min-w-0 justify-end"
    >
      <SocketRows group={layout.access} uplink={false} activity={activity} seed={deviceId} offset={0} />
      <SocketRows group={layout.uplinks} uplink activity={activity} seed={deviceId} offset={accessCount} />
    </div>
  );
});

// ── Health strip (UPS / server without a meaningful port block) ─────────────
// UPS: battery charge bar plus charge / runtime; server: condition dot plus
// status and the hottest sensor. Falls back to a muted hint without data.
export function HealthStrip({ device }: { device: TopologyNode }) {
  const health = healthOf(device);
  const kind = deviceTypeOf(device);
  if (!health) {
    return (
      <div data-testid="health-strip" data-kind={kind} className="flex-1 min-w-0 flex items-center justify-end">
        <span className="text-[9px] text-muted truncate">No health data</span>
      </div>
    );
  }
  const statusLabel = HEALTH_STATUS_LABEL[health.status] ?? HEALTH_STATUS_LABEL.unknown;
  if (health.kind === "ups") {
    const charge = health.charge_percent;
    const runtime = formatRuntime(health.runtime_minutes);
    const title = [
      `UPS ${statusLabel}`,
      charge != null ? `charge ${charge}%` : null,
      runtime ? `runtime ${runtime}` : null,
      health.load_percent != null ? `load ${health.load_percent}%` : null,
    ].filter(Boolean).join(", ");
    return (
      <div
        data-testid="health-strip"
        data-kind="ups"
        data-status={health.status}
        title={title}
        className="flex-1 min-w-0 flex items-center gap-1.5 justify-end"
      >
        <div
          className="h-1.5 w-full max-w-24 rounded-full bg-panel-2 border border-line overflow-hidden"
          role="img"
          aria-label={charge != null ? `Battery charge ${charge}%` : "Battery charge unknown"}
        >
          <div
            data-testid="health-charge-bar"
            className={`h-full ${healthStatusBg(health.status)}`}
            style={{ width: `${clampPercent(charge)}%` }}
          />
        </div>
        <span className="text-[9px] font-mono tabular-nums text-muted shrink-0">
          {charge != null ? `${charge}%` : "-"}
          {runtime ? ` ${runtime}` : ""}
        </span>
      </div>
    );
  }
  const temp = health.temperature_max_c != null ? `${health.temperature_max_c} C` : "";
  return (
    <div
      data-testid="health-strip"
      data-kind="server"
      data-status={health.status}
      title={`Server ${statusLabel}${temp ? `, max ${temp}` : ""}`}
      className="flex-1 min-w-0 flex items-center gap-1.5 justify-end"
    >
      <span
        data-testid="health-condition-dot"
        className={`w-2 h-2 rounded-full shrink-0 ${healthStatusBg(health.status)}`}
        aria-hidden="true"
      />
      <span className="text-[9px] text-muted truncate">{statusLabel}</span>
      {temp && <span className="text-[9px] font-mono tabular-nums text-muted shrink-0">{temp}</span>}
    </div>
  );
}

// ── Rack ear with two screws ────────────────────────────────────────────────
function RackEar({ side }: { side: "left" | "right" }) {
  return (
    <span className={`rack-ear rack-ear-${side}`} aria-hidden="true">
      <span className="rack-screw" />
      <span className="rack-screw" />
    </span>
  );
}

// ── Side rail with square mounting holes and U numbers ──────────────────────
function RackRail({ side, rows, testId }: { side: "left" | "right"; rows: number[]; testId: string }) {
  const holes = (
    <span className="rack-rail-holes" aria-hidden="true">
      <span className="rack-rail-hole" />
      <span className="rack-rail-hole" />
      <span className="rack-rail-hole" />
    </span>
  );
  return (
    <div className={`rack-rail rack-rail-${side} flex flex-col w-7 shrink-0`} data-testid={testId}>
      {rows.map((u) => (
        <div key={u} className="rack-rail-unit flex items-stretch" style={{ height: U_PX }}>
          {side === "right" && holes}
          <span
            className={`flex-1 flex items-center font-mono tabular-nums text-[9px] text-muted ${
              side === "left" ? "justify-end pr-0.5" : "justify-start pl-0.5"
            }`}
          >
            {u}
          </span>
          {side === "left" && holes}
        </div>
      ))}
    </div>
  );
}

// ── U height stepper ─────────────────────────────────────────────────────────
// Upper bound of the stepper: the device meta API accepts u_height 1-60
// (DeviceMetaUpdate in backend/schemas.py); the rack height caps it further.
export const MAX_DEVICE_U = 60;

function UHeightControl({
  device,
  heightU,
  readOnly,
  onChange,
}: {
  device: TopologyNode;
  heightU: number;
  readOnly: boolean;
  onChange: (uHeight: number) => void;
}) {
  const uHeight = deviceUHeight(device);
  const max = Math.min(MAX_DEVICE_U, heightU);
  const btn =
    "w-3.5 h-3.5 inline-flex items-center justify-center rounded-[3px] border border-line-strong bg-panel text-muted hover:text-primary hover:border-accent disabled:opacity-30 disabled:hover:text-muted disabled:hover:border-line-strong cursor-pointer disabled:cursor-default text-[10px] leading-none";
  return (
    <div className="flex items-center gap-0.5 shrink-0" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={`Decrease U height of ${device.sys_name}`}
        className={btn}
        disabled={readOnly || uHeight <= 1}
        onClick={() => onChange(uHeight - 1)}
      >
        -
      </button>
      <span className="text-[9px] font-mono tabular-nums text-muted w-5 text-center">{uHeight}U</span>
      <button
        type="button"
        aria-label={`Increase U height of ${device.sys_name}`}
        className={btn}
        disabled={readOnly || uHeight >= max}
        onClick={() => onChange(uHeight + 1)}
      >
        +
      </button>
    </div>
  );
}

// ── Full-depth toggle ───────────────────────────────────────────────────────
// Sits next to the U-height stepper: pressed = the device blocks its U range
// on both the front and the rear face.
function FullDepthToggle({
  device,
  readOnly,
  onToggle,
}: {
  device: TopologyNode;
  readOnly: boolean;
  onToggle: () => void;
}) {
  const on = fullDepthOf(device);
  const name = deviceName(device);
  return (
    <button
      type="button"
      data-testid={`full-depth-toggle-${device.id}`}
      aria-pressed={on}
      aria-label={`Full depth for ${name}`}
      title={on ? "Full depth: blocks this U range on front and rear" : "Mark as full depth (blocks front and rear)"}
      disabled={readOnly}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center rounded-[3px] border cursor-pointer disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
        on
          ? "border-accent bg-accent-soft text-accent"
          : "border-line-strong bg-panel text-muted hover:text-primary hover:border-accent disabled:opacity-30 disabled:hover:text-muted disabled:hover:border-line-strong"
      }`}
    >
      <Layers size={9} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

function deviceName(device: TopologyNode): string {
  return deviceDisplayName(device);
}

// ── Remove-from-rack button ─────────────────────────────────────────────────
// Non-drag alternative to dropping a device onto the tray. On faceplates it
// only shows on hover/focus (reveal=true) to keep the plate uncluttered.
function RemoveFromRackButton({
  device,
  reveal = false,
  onRemove,
}: {
  device: TopologyNode;
  reveal?: boolean;
  onRemove: () => void;
}) {
  const name = deviceName(device);
  return (
    <button
      type="button"
      data-testid={`remove-from-rack-${device.id}`}
      aria-label={`Remove ${name} from rack`}
      title="Remove from rack"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      className={`w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center rounded-[3px] border border-line-strong bg-panel text-muted hover:text-danger hover:border-danger cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
        reveal ? "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100" : ""
      }`}
    >
      <X size={10} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

// Height of the rack cap above the rails; the label column is offset by it so
// label tops line up with faceplate tops (both measured from the rack body).
const RACK_CAP_PX = 8;

// ── Device label (annotation right of the rack) ─────────────────────────────
// One label per placed device, drawn like an annotation on a plan: a thin
// dashed leader from the right rail to the label text. Name and model sit on
// ONE line (name semibold, model muted mono) so tightly stacked 1U devices
// keep a full 26px row per label instead of two cramped lines. The row is
// aligned with the faceplate top and spans one U, so multi-U devices are
// annotated at their top U. The label is a plain button: it opens the
// inspector and never starts a drag.
function RackLabel({
  device,
  top,
  highlighted,
  dragging,
  onHighlight,
  onOpen,
}: {
  device: TopologyNode;
  top: number;
  highlighted: boolean;
  dragging: boolean;
  onHighlight: (on: boolean) => void;
  onOpen: () => void;
}) {
  const name = deviceName(device);
  const ident = device.model ? `${name} - ${device.model}` : name;
  return (
    <div
      data-testid={`rack-label-${device.id}`}
      className={`rack-label absolute inset-x-0 flex items-center ${highlighted ? "rack-label-highlight" : ""} ${
        dragging ? "opacity-40" : ""
      }`}
      style={{ top, height: U_PX - 2 }}
    >
      <span className="rack-leader" aria-hidden="true" />
      <button
        type="button"
        data-testid={`rack-label-button-${device.id}`}
        aria-label={`Open details for ${name}`}
        title={ident}
        onClick={onOpen}
        onMouseEnter={() => onHighlight(true)}
        onMouseLeave={() => onHighlight(false)}
        onFocus={() => onHighlight(true)}
        onBlur={() => onHighlight(false)}
        className="flex items-center gap-1.5 min-w-0 max-w-full h-full pl-1.5 pr-1 rounded-[3px] text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-accent"
      >
        <VendorBadge vendor={device.vendor} />
        <span
          className={`rack-label-name text-[12px] leading-4 font-semibold truncate min-w-0 transition-colors duration-[120ms] motion-reduce:transition-none ${
            highlighted ? "text-accent" : "text-primary"
          }`}
        >
          {name}
        </span>
        {device.model && (
          <span className="rack-label-model text-muted text-[11px] leading-4 font-mono truncate min-w-0 shrink-[2]">
            {device.model}
          </span>
        )}
      </button>
    </div>
  );
}

// ── Device faceplate ─────────────────────────────────────────────────────────
function Faceplate({
  device,
  readOnly,
  dragging,
  heightU,
  onPointerDown,
  onUHeight,
  onFullDepth,
  onOpen,
  activity,
  highlighted,
  onHighlight,
  onRemove,
  switchClass,
}: {
  device: TopologyNode;
  readOnly: boolean;
  dragging: boolean;
  heightU: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onUHeight: (uHeight: number) => void;
  onFullDepth: () => void;
  onOpen: () => void;
  activity: boolean;
  // Remove the device from the rack; omitted (no button) in read-only mode.
  onRemove?: () => void;
  // Shared hover/focus highlight with the device's label in the label column.
  highlighted: boolean;
  onHighlight: (on: boolean) => void;
  // Assigned switch class, drawn as a thin stripe in its (user-chosen) color.
  switchClass?: SwitchClass | null;
}) {
  const ping = device.ping_status || "unknown";
  const status = ping === "online" ? "up" : ping === "offline" ? "down" : "unknown";
  const name = deviceName(device);
  const rtt = ping === "online" && device.ping_rtt_ms != null ? `${device.ping_rtt_ms}ms` : "";
  const ledTitle =
    status === "up" ? `ping online${rtt ? ` (${rtt})` : ""}` : status === "down" ? "ping offline" : "ping unknown";
  // The visible name lives in the label column; the faceplate keeps it in its
  // accessible name and tooltip.
  const ident = device.model ? `${name} (${device.model})` : name;
  const border = highlighted
    ? "border-accent rack-plate-highlight"
    : readOnly
      ? "border-line hover:border-accent"
      : "border-line-strong hover:border-accent";
  return (
    <div
      data-testid={`faceplate-${device.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${name} - open details`}
      title={readOnly ? `${ident} - click to open details` : `${ident} - click to open details, drag to move`}
      onPointerDown={onPointerDown}
      onMouseEnter={() => onHighlight(true)}
      onMouseLeave={() => onHighlight(false)}
      onFocus={() => onHighlight(true)}
      onBlur={() => onHighlight(false)}
      // Read-only racks have no drag gesture, so a plain click opens details.
      // Editable racks open via the click-vs-drag threshold in useRackDrag.
      onClick={readOnly ? onOpen : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`rack-plate group flex items-stretch h-full w-full rounded-[2px] border overflow-hidden select-none transition-colors duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${border} ${
        readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
      } ${dragging ? "opacity-40" : ""}`}
      style={{ touchAction: "none" }}
    >
      {switchClass && (
        <span
          data-testid={`faceplate-class-${device.id}`}
          title={`Class: ${switchClass.label}`}
          className="w-[3px] shrink-0"
          style={{ backgroundColor: switchClass.color }}
        />
      )}
      <RackEar side="left" />
      {/* No name/model block: names live in the label column right of the
          rack, so the port block gets the full width between LED and stepper. */}
      <div className="flex items-center gap-1.5 px-1.5 flex-1 min-w-0">
        <span
          data-testid="device-status-led"
          data-status={status}
          title={ledTitle}
          className={`rack-status-led rack-status-led-${status}`}
        />
        {/* UPS / server: the health strip replaces an empty port block, and
            also a management port block once a health snapshot exists. */}
        {isPowerOrServer(device) && ((device.ports?.length ?? 0) === 0 || healthOf(device)) ? (
          <HealthStrip device={device} />
        ) : (
          <PortBlock
            deviceId={device.id}
            ports={device.ports}
            totalPorts={device.total_ports}
            activity={activity}
          />
        )}
        <UHeightControl device={device} heightU={heightU} readOnly={readOnly} onChange={onUHeight} />
        <FullDepthToggle device={device} readOnly={readOnly} onToggle={onFullDepth} />
        {!readOnly && onRemove && <RemoveFromRackButton device={device} reveal onRemove={onRemove} />}
      </div>
      <RackEar side="right" />
    </div>
  );
}

// ── Rack item faceplate (manual placeholder) ────────────────────────────────
// Muted, dashed plate without status LED or live ports: a patch panel shows a
// row of dimmed port-like squares per U (at most two rows), a cable manager a
// row of slots, a shelf a tray lip; blank and other plates stay plain. Items
// are draggable like faceplates (U position and side); a click below the drag
// threshold opens the item dialog.
const PATCH_PANEL_PORTS = 24;
const CABLE_MANAGER_SLOTS = 10;

function RackItemFace({ item }: { item: RackItem }) {
  if (item.kind === "patch_panel") {
    const rows = Math.min(2, Math.max(1, item.u_height));
    return (
      <div data-testid="rack-item-ports" className="flex flex-col justify-center gap-px flex-1 min-w-0 overflow-hidden">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-px justify-center">
            {Array.from({ length: PATCH_PANEL_PORTS }, (_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className="w-2 h-2 rounded-[1px] border border-line-strong bg-surface opacity-70"
              />
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (item.kind === "cable_manager") {
    return (
      <div className="flex items-center justify-center gap-1 flex-1 min-w-0 overflow-hidden">
        {Array.from({ length: CABLE_MANAGER_SLOTS }, (_, i) => (
          <span key={i} aria-hidden="true" className="w-5 h-2 rounded-full border border-line-strong bg-surface opacity-70" />
        ))}
      </div>
    );
  }
  if (item.kind === "shelf") {
    return (
      <div className="flex items-end flex-1 min-w-0 pb-0.5">
        <span aria-hidden="true" className="h-1 w-full rounded-[1px] bg-line-strong opacity-70" />
      </div>
    );
  }
  return <div className="flex-1 min-w-0" />;
}

function RackItemPlate({
  item,
  readOnly,
  dragging,
  highlighted,
  onHighlight,
  onPointerDown,
  onOpen,
}: {
  item: RackItem;
  readOnly: boolean;
  dragging: boolean;
  highlighted: boolean;
  onHighlight: (on: boolean) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onOpen: () => void;
}) {
  const name = item.label || rackItemKindLabel(item.kind);
  const action = readOnly ? "view details" : "edit";
  const title = item.note ? `${name} - ${item.note}` : name;
  return (
    <div
      data-testid={`rack-item-${item.id}`}
      data-kind={item.kind}
      data-side={sideOf(item)}
      data-full-depth={fullDepthOf(item) ? "1" : "0"}
      role="button"
      tabIndex={0}
      aria-label={`${name} (${rackItemKindLabel(item.kind)}) - ${action}`}
      title={readOnly ? title : `${title} - click to edit, drag to move`}
      onPointerDown={onPointerDown}
      // Read-only racks have no drag gesture, so a plain click opens the
      // dialog; editable racks open via the click-vs-drag threshold.
      onClick={readOnly ? onOpen : undefined}
      onMouseEnter={() => onHighlight(true)}
      onMouseLeave={() => onHighlight(false)}
      onFocus={() => onHighlight(true)}
      onBlur={() => onHighlight(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`flex items-stretch h-full w-full rounded-[2px] border border-dashed bg-panel-2 overflow-hidden select-none transition-colors duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
        highlighted ? "border-accent" : "border-line-strong hover:border-accent"
      } ${readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"} ${dragging ? "opacity-40" : ""}`}
      style={{ touchAction: "none" }}
    >
      <RackEar side="left" />
      <div className="flex items-stretch gap-1.5 px-1.5 py-px flex-1 min-w-0">
        <RackItemFace item={item} />
      </div>
      <RackEar side="right" />
    </div>
  );
}

// Annotation for a rack item in the label column, styled like a device label
// but muted (kind instead of model, no vendor badge).
function RackItemLabel({
  item,
  top,
  highlighted,
  onHighlight,
  onOpen,
}: {
  item: RackItem;
  top: number;
  highlighted: boolean;
  onHighlight: (on: boolean) => void;
  onOpen: () => void;
}) {
  const kind = rackItemKindLabel(item.kind);
  return (
    <div
      data-testid={`rack-item-label-${item.id}`}
      className={`rack-label absolute inset-x-0 flex items-center ${highlighted ? "rack-label-highlight" : ""}`}
      style={{ top, height: U_PX - 2 }}
    >
      <span className="rack-leader" aria-hidden="true" />
      <button
        type="button"
        aria-label={`Open rack item ${item.label || kind}`}
        title={item.note ? `${item.label || kind} - ${item.note}` : item.label || kind}
        onClick={onOpen}
        onMouseEnter={() => onHighlight(true)}
        onMouseLeave={() => onHighlight(false)}
        onFocus={() => onHighlight(true)}
        onBlur={() => onHighlight(false)}
        className="flex items-center gap-1.5 min-w-0 max-w-full h-full pl-1.5 pr-1 rounded-[3px] text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-accent"
      >
        {item.label && (
          <span
            className={`text-[12px] leading-4 truncate min-w-0 transition-colors duration-[120ms] motion-reduce:transition-none ${
              highlighted ? "text-accent" : "text-primary"
            }`}
          >
            {item.label}
          </span>
        )}
        <span className="text-muted text-[11px] leading-4 font-mono truncate min-w-0 shrink-[2]">{kind}</span>
      </button>
    </div>
  );
}

// ── Full-depth shadow (opposite face) ───────────────────────────────────────
// Hatched, muted placeholder drawn on the face opposite a full-depth object
// so the blocked U range is visible there. Never draggable; a click opens
// the object's inspector / dialog.
function RackShadowPlate({
  testId,
  name,
  mountedSide,
  highlighted,
  onHighlight,
  onOpen,
}: {
  testId: string;
  name: string;
  mountedSide: RackSide;
  highlighted: boolean;
  onHighlight: (on: boolean) => void;
  onOpen: () => void;
}) {
  const sideLabel = mountedSide === "front" ? "front" : "rear";
  return (
    <div
      data-testid={testId}
      data-shadow="1"
      role="button"
      tabIndex={0}
      aria-label={`${name} (full depth, mounted on the ${sideLabel}) - open details`}
      title={`${name} - full depth, mounted on the ${sideLabel}`}
      onClick={onOpen}
      onMouseEnter={() => onHighlight(true)}
      onMouseLeave={() => onHighlight(false)}
      onFocus={() => onHighlight(true)}
      onBlur={() => onHighlight(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`flex items-center justify-center h-full w-full rounded-[2px] border border-dashed bg-panel-2 bg-[image:repeating-linear-gradient(135deg,var(--line-strong)_0_1px,transparent_1px_7px)] overflow-hidden select-none cursor-pointer opacity-70 hover:opacity-100 transition-opacity duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
        highlighted ? "border-accent opacity-100" : "border-line-strong"
      }`}
    >
      <span className="px-1.5 rounded-[2px] bg-panel-2 text-[10px] leading-4 text-muted truncate max-w-[90%]">
        {name} - full depth ({sideLabel})
      </span>
    </div>
  );
}

// ── Item palette ─────────────────────────────────────────────────────────────
// One entry per rack item kind with its default height. Dragging an entry
// onto either face creates an item there immediately; a click or Enter opens
// the item dialog prefilled with that kind.
function RackItemPalette({
  draggingKind,
  onPointerDown,
  onOpen,
}: {
  draggingKind: RackItemKind | null;
  onPointerDown: (e: React.PointerEvent, kind: RackItemKind, uHeight: number) => void;
  onOpen: (kind: RackItemKind) => void;
}) {
  return (
    <div data-testid="rack-item-palette" className="border border-line rounded-card bg-panel">
      <div className="px-3 py-2 border-b border-line text-[11px] font-semibold text-muted">Rack items</div>
      <div className="grid grid-cols-2 gap-1 p-1.5">
        {RACK_ITEM_KINDS.map((k) => (
          <div
            key={k.value}
            data-testid={`palette-item-${k.value}`}
            role="button"
            tabIndex={0}
            aria-label={`Add ${k.label} (${k.defaultU}U)`}
            title={`${k.label} (${k.defaultU}U) - drag onto the front or rear, or click to add with details`}
            onPointerDown={(e) => onPointerDown(e, k.value, k.defaultU)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                e.preventDefault();
                onOpen(k.value);
              }
            }}
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded border border-dashed border-line-strong bg-panel-2 text-[11px] select-none cursor-grab active:cursor-grabbing hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              draggingKind === k.value ? "opacity-40" : ""
            }`}
            style={{ touchAction: "none" }}
          >
            <GripVertical size={12} className="text-muted shrink-0" aria-hidden="true" />
            <span className="text-primary truncate">{k.label}</span>
            <span className="text-muted text-[10px] ml-auto shrink-0">{k.defaultU}U</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function uRangeLabel(pos: number, uHeight: number): string {
  return uHeight <= 1 ? `U${pos}` : `U${pos}-U${pos + uHeight - 1}`;
}

const SIDE_LABEL: Record<RackSide, string> = { front: "Front", rear: "Rear" };

// ── RackElevation ────────────────────────────────────────────────────────────
export default function RackElevation({
  rack,
  nodes,
  readOnly = false,
  activity = false,
  classes,
}: RackElevationProps) {
  const heightU = rackHeightU(rack);
  const classById = useMemo(() => new Map((classes ?? []).map((c) => [c.id, c])), [classes]);
  const frontBodyRef = useRef<HTMLDivElement>(null);
  const rearBodyRef = useRef<HTMLDivElement>(null);
  const bodyRefs: RackBodyRefs = useMemo(() => ({ front: frontBodyRef, rear: rearBodyRef }), []);
  const { addToast } = useToast();

  // Placements are clamped/dropped when out of range (placementsFromNodes),
  // so a device that cannot fit inside the rack lands in the tray instead of
  // rendering a faceplate outside the frame.
  const placements = useMemo(() => placementsFromNodes(nodes, rack.id, heightU), [nodes, rack.id, heightU]);
  const placementById = useMemo(() => new Map(placements.map((p) => [p.deviceId, p])), [placements]);

  const placed = useMemo(() => nodes.filter((n) => placementById.has(n.id)), [nodes, placementById]);
  const trayInRack = useMemo(
    () => nodes.filter((n) => n.rack_id === rack.id && !placementById.has(n.id)),
    [nodes, rack.id, placementById],
  );
  const trayNoRack = useMemo(
    () => nodes.filter((n) => n.rack_id == null && !n.ignored),
    [nodes],
  );

  // Manual rack items (patch panels, blanks, ...): rendered at their U range
  // and face, counted as used and treated as occupied by drag-and-drop.
  const { data: rackItemData } = useRackItems(rack.id);
  const rackItems = useMemo(() => rackItemData ?? [], [rackItemData]);
  const blocks = useMemo(() => itemBlocks(rackItems, heightU), [rackItems, heightU]);
  const placedItems = useMemo(() => {
    const visible = new Set(blocks.map((b) => b.id));
    return rackItems
      .filter((i) => visible.has(i.id))
      .map((item) => {
        const uHeight = Math.max(1, item.u_height);
        return {
          item,
          uHeight,
          side: sideOf(item),
          fullDepth: fullDepthOf(item),
          top: rowFromTop(heightU, item.rack_u_position, uHeight) * U_PX + 1,
        };
      });
  }, [rackItems, blocks, heightU]);

  const [itemDialog, setItemDialog] = useState<{ open: boolean; item: RackItem | null; kind: RackItemKind }>({
    open: false,
    item: null,
    kind: "patch_panel",
  });
  const closeItemDialog = useCallback(() => setItemDialog((d) => ({ ...d, open: false })), []);
  const openItem = useCallback((item: RackItem) => setItemDialog({ open: true, item, kind: item.kind }), []);
  const openNewItem = useCallback((kind: RackItemKind) => setItemDialog({ open: true, item: null, kind }), []);
  const defaultItemPos = useMemo(
    () => topmostFreeU(heightU, [...placements, ...blocks], { side: "front" }, rackItemDefaultU(itemDialog.kind)),
    [heightU, placements, blocks, itemDialog.kind],
  );
  const [hoveredItemId, setHoveredItemId] = useState<number | null>(null);
  const highlightItem = useCallback((id: number, on: boolean) => {
    setHoveredItemId((cur) => (on ? id : cur === id ? null : cur));
  }, []);

  const { moveDevice, assignDevice, setUHeight, setFullDepth, removeDevice, saving } = useRackLayout(rack.id);
  const createItem = useCreateRackItem(rack.id);
  const updateItem = useUpdateRackItem(rack.id, { optimistic: true });
  const trayRef = useRef<HTMLDivElement>(null);

  const createItemMutate = createItem.mutate;
  const updateItemMutate = updateItem.mutate;
  const onDrop = useCallback(
    (payload: RackDragPayload, source: RackDragSource, target: DropTarget, uHeight: number) => {
      const { pos, side } = target;
      if (payload.type === "device") {
        const device = payload.device;
        if (source === "tray" && device.rack_id !== rack.id) {
          assignDevice(device, pos, uHeight, side);
        } else {
          moveDevice(device, pos, uHeight, side);
        }
        return;
      }
      if (payload.type === "item") {
        const item = payload.item;
        if (item.rack_u_position === pos && sideOf(item) === side) return;
        updateItemMutate(
          { id: item.id, rack_u_position: pos, rack_side: side },
          { onError: (ex) => addToast(`Rack item not saved: ${extractErrorMessage(ex)}`, "error") },
        );
        return;
      }
      createItemMutate(
        {
          kind: payload.kind,
          label: "",
          rack_u_position: pos,
          u_height: uHeight,
          rack_side: side,
          full_depth: false,
          note: null,
        },
        { onError: (ex) => addToast(`Rack item not created: ${extractErrorMessage(ex)}`, "error") },
      );
    },
    [assignDevice, moveDevice, rack.id, updateItemMutate, createItemMutate, addToast],
  );

  const { open: openInspector } = useInspector();
  const openDevice = useCallback((device: TopologyNode) => openInspector("device", device.id), [openInspector]);

  const onDragClick = useCallback(
    (payload: RackDragPayload) => {
      if (payload.type === "device") openDevice(payload.device);
      else if (payload.type === "item") openItem(payload.item);
      else openNewItem(payload.kind);
    },
    [openDevice, openItem, openNewItem],
  );

  const { drag, startDrag } = useRackDrag({
    rackId: rack.id,
    heightU,
    nodes,
    blocked: blocks,
    bodyRefs,
    trayRef,
    readOnly,
    onDrop,
    onRemove: removeDevice,
    onClick: onDragClick,
  });
  const dragKey = drag ? dragPayloadKey(drag.payload) : null;
  // A placed device is being dragged: the tray turns into a removal target.
  const trayDropActive = drag?.source === "rack" && drag.payload.type === "device";

  // Full-depth toggle: refuse locally when the opposite face is occupied.
  const toggleFullDepth = useCallback(
    (device: TopologyNode) => {
      const next = !fullDepthOf(device);
      const pl = placementById.get(device.id);
      if (next && pl) {
        const side = pl.side ?? "front";
        if (!placementValid(placements, device.id, pl.pos, pl.uHeight, heightU, blocks, { side, fullDepth: true })) {
          addToast(
            `Cannot make ${deviceName(device)} full depth: ${uRangeLabel(pl.pos, pl.uHeight)} on the ${oppositeSide(side)} is occupied`,
            "error",
          );
          return;
        }
      }
      setFullDepth(device, next);
    },
    [placementById, placements, heightU, blocks, addToast, setFullDepth],
  );

  const scaleRows = Array.from({ length: heightU }, (_, i) => heightU - i); // top row shows heightU

  // Pixel top of every placed device, shared by its faceplate, its shadow
  // and its label.
  const placedRows = useMemo(
    () =>
      placed.map((device) => {
        const pl = placementById.get(device.id);
        const uHeight = pl?.uHeight ?? deviceUHeight(device);
        const pos = pl?.pos ?? (device.rack_u_position as number);
        return {
          device,
          uHeight,
          side: pl?.side ?? sideOf(device),
          fullDepth: pl?.fullDepth ?? fullDepthOf(device),
          top: rowFromTop(heightU, pos, uHeight) * U_PX + 1,
        };
      }),
    [placed, placementById, heightU],
  );

  // Shared hover/focus highlight between a faceplate, its shadow and its
  // label. Leaving one element only clears the highlight it set, so moving
  // between them never flickers another device. Suppressed while a drag is
  // in progress.
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const highlight = useCallback((id: number, on: boolean) => {
    setHoveredId((cur) => (on ? id : cur === id ? null : cur));
  }, []);
  const highlightId = drag ? null : hoveredId;

  const renderGhost = (side: RackSide) => {
    const target = drag?.target;
    if (!drag || !target) return null;
    const primary = target.side === side;
    // A full-depth drag also previews the blocked range on the other face.
    if (!primary && !drag.fullDepth) return null;
    const tone = target.valid ? "border-accent bg-accent/15" : "border-danger bg-danger/15";
    return (
      <div
        data-testid={primary ? "drop-ghost" : "drop-ghost-shadow"}
        data-valid={target.valid ? "1" : "0"}
        data-side={side}
        className={`absolute inset-x-1 rounded pointer-events-none border ${tone} ${
          primary ? "" : "border-dashed opacity-60"
        }`}
        style={{
          top: target.row * U_PX + 1,
          height: drag.uHeight * U_PX - 2,
        }}
      >
        <span className="absolute right-1 top-0 text-[9px] text-muted">
          U{target.pos}
          {primary ? "" : " (full depth)"}
        </span>
      </div>
    );
  };

  const renderSide = (side: RackSide) => {
    const used = usedUnits(placements, blocks, side);
    const deviceRows = placedRows.filter((r) => r.side === side);
    const deviceShadows = placedRows.filter((r) => r.fullDepth && r.side !== side);
    const itemRows = placedItems.filter((r) => r.side === side);
    const itemShadows = placedItems.filter((r) => r.fullDepth && r.side !== side);
    return (
      <div key={side} data-testid={`rack-side-${side}`} className="flex flex-col gap-1.5 min-w-0 max-w-full">
        <div className="flex items-baseline gap-2 h-5">
          <span className="text-primary text-[11px] font-semibold uppercase tracking-wide">{SIDE_LABEL[side]}</span>
          <span className="text-muted text-[11px]">
            {used}/{heightU} U used - {heightU - used} U free
          </span>
        </div>
        {/* Rack face + label column share one horizontal scroll container so
            label rows stay aligned with their faceplates on narrow screens. */}
        <div data-testid={`rack-scroll-${side}`} className="min-w-0 max-w-full overflow-x-auto pb-1">
          <div className="flex items-start w-max">
            {/* Rack frame: top cap, rails + interior, bottom cap */}
            <div className="rack-frame flex flex-col shrink-0">
              <div className="rack-cap" aria-hidden="true" />
              <div className="flex">
                <RackRail side="left" rows={scaleRows} testId={`rack-rail-${side}-left`} />

                <div
                  ref={bodyRefs[side]}
                  data-testid={`rack-body-${side}`}
                  aria-label={`${SIDE_LABEL[side]} of ${rack.label}`}
                  className="rack-interior relative w-[440px]"
                  style={{ height: heightU * U_PX }}
                >
                  {/* Blanking plates for every slot (devices render on top) */}
                  {Array.from({ length: heightU }, (_, i) => (
                    <div
                      key={i}
                      className="rack-blank absolute inset-x-0"
                      style={{ top: i * U_PX, height: U_PX }}
                      aria-hidden="true"
                    />
                  ))}

                  {/* Full-depth shadows of objects mounted on the other face */}
                  {deviceShadows.map(({ device, top, uHeight }) => (
                    <div
                      key={`shadow-device-${device.id}`}
                      className={`absolute ${dragKey === `device-${device.id}` ? "opacity-40" : ""}`}
                      style={{ top, height: uHeight * U_PX - 2, left: 0, right: 0 }}
                    >
                      <RackShadowPlate
                        testId={`rack-shadow-device-${device.id}`}
                        name={deviceName(device)}
                        mountedSide={oppositeSide(side)}
                        highlighted={highlightId === device.id}
                        onHighlight={(on) => highlight(device.id, on)}
                        onOpen={() => openDevice(device)}
                      />
                    </div>
                  ))}
                  {itemShadows.map(({ item, top, uHeight }) => (
                    <div
                      key={`shadow-item-${item.id}`}
                      className={`absolute ${dragKey === `item-${item.id}` ? "opacity-40" : ""}`}
                      style={{ top, height: uHeight * U_PX - 2, left: 0, right: 0 }}
                    >
                      <RackShadowPlate
                        testId={`rack-shadow-item-${item.id}`}
                        name={item.label || rackItemKindLabel(item.kind)}
                        mountedSide={oppositeSide(side)}
                        highlighted={!drag && hoveredItemId === item.id}
                        onHighlight={(on) => highlightItem(item.id, on)}
                        onOpen={() => openItem(item)}
                      />
                    </div>
                  ))}

                  {/* Placed devices */}
                  {deviceRows.map(({ device, top, uHeight }) => (
                    <div
                      key={device.id}
                      className="absolute"
                      style={{
                        top,
                        height: uHeight * U_PX - 2,
                        left: 0,
                        right: 0,
                      }}
                    >
                      <Faceplate
                        device={device}
                        readOnly={readOnly}
                        dragging={dragKey === `device-${device.id}`}
                        heightU={heightU}
                        onPointerDown={(e) => startDrag(e, { type: "device", device }, "rack")}
                        onUHeight={(h) => setUHeight(device, h)}
                        onFullDepth={() => toggleFullDepth(device)}
                        onOpen={() => openDevice(device)}
                        activity={activity}
                        highlighted={highlightId === device.id}
                        onHighlight={(on) => highlight(device.id, on)}
                        onRemove={readOnly ? undefined : () => removeDevice(device)}
                        switchClass={device.class_id != null ? classById.get(device.class_id) : null}
                      />
                    </div>
                  ))}

                  {/* Manual rack items (draggable; click opens the item dialog) */}
                  {itemRows.map(({ item, top, uHeight }) => (
                    <div
                      key={`item-${item.id}`}
                      className="absolute"
                      style={{ top, height: uHeight * U_PX - 2, left: 0, right: 0 }}
                    >
                      <RackItemPlate
                        item={item}
                        readOnly={readOnly}
                        dragging={dragKey === `item-${item.id}`}
                        highlighted={!drag && hoveredItemId === item.id}
                        onHighlight={(on) => highlightItem(item.id, on)}
                        onPointerDown={(e) => startDrag(e, { type: "item", item }, "rack")}
                        onOpen={() => openItem(item)}
                      />
                    </div>
                  ))}

                  {renderGhost(side)}
                </div>

                <RackRail side="right" rows={scaleRows} testId={`rack-rail-${side}-right`} />
              </div>
              <div className="rack-cap" aria-hidden="true" />
              {side === "front" && (
                <div className="pt-2">
                  <PortLegend />
                </div>
              )}
            </div>

            {/* Label column: one annotation per object mounted on this face,
                offset by the top cap so each label top equals its faceplate
                top. The dragged device's label is dimmed in place (like its
                faceplate) instead of following the ghost. Shadows have no
                label; the label lives on the mounted face. */}
            <div
              data-testid={`rack-label-column-${side}`}
              className="relative shrink-0"
              style={{ marginTop: RACK_CAP_PX, height: heightU * U_PX, width: "clamp(160px, 16vw, 280px)" }}
            >
              {deviceRows.map(({ device, top }) => (
                <RackLabel
                  key={device.id}
                  device={device}
                  top={top}
                  highlighted={highlightId === device.id}
                  dragging={dragKey === `device-${device.id}`}
                  onHighlight={(on) => highlight(device.id, on)}
                  onOpen={() => openDevice(device)}
                />
              ))}
              {itemRows.map(({ item, top }) => (
                <RackItemLabel
                  key={`item-${item.id}`}
                  item={item}
                  top={top}
                  highlighted={!drag && hoveredItemId === item.id}
                  onHighlight={(on) => highlightItem(item.id, on)}
                  onOpen={() => openItem(item)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Rack header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-primary font-semibold text-sm">{rack.label}</span>
        {rack.room && <span className="text-muted text-[11px]">{rack.room}</span>}
        <Badge tone="accent">{heightU}U</Badge>
        {saving && <span className="text-muted text-[11px]">Saving...</span>}
        {readOnly && (
          <span className="text-warning text-[11px]">
            View-only: sign in as operator or admin to rearrange devices
          </span>
        )}
      </div>

      <div className="flex gap-4 items-start flex-wrap">
        {/* Front and rear faces side by side on the same U scale; they wrap
            below each other when the viewport is too narrow. */}
        <div data-testid="rack-sides" className="flex flex-wrap gap-x-6 gap-y-4 items-start min-w-0 max-w-full">
          {RACK_SIDES.map((side) => renderSide(side))}
        </div>

        <div className="flex flex-col gap-3 min-w-[240px] flex-1 max-w-[360px]">
          {!readOnly && (
            <RackItemPalette
              draggingKind={drag?.payload.type === "palette" ? drag.payload.kind : null}
              onPointerDown={(e, kind, uHeight) => startDrag(e, { type: "palette", kind, uHeight }, "palette")}
              onOpen={openNewItem}
            />
          )}

          {/* Unassigned devices tray; doubles as the "remove from rack" drop
              target while a placed device is dragged. */}
          <div
            ref={trayRef}
            data-testid="rack-tray"
            data-drop-active={trayDropActive ? "1" : "0"}
            data-drop-over={trayDropActive && drag?.overTray ? "1" : "0"}
            className={`flex flex-col gap-3 rounded-card transition-colors duration-[120ms] motion-reduce:transition-none ${
              trayDropActive
                ? `outline-2 outline-dashed outline-offset-4 ${drag?.overTray ? "outline-accent bg-accent/10" : "outline-line-strong"}`
                : ""
            }`}
          >
            {trayDropActive && (
              <div
                data-testid="rack-tray-drop-hint"
                className={`px-3 py-2 rounded-card border border-dashed text-[11px] font-semibold text-center ${
                  drag?.overTray ? "border-accent text-accent bg-accent/15" : "border-line-strong text-muted bg-panel"
                }`}
              >
                Drop here to remove from rack
              </div>
            )}
            <TraySection
              title="Unplaced in this rack"
              devices={trayInRack}
              readOnly={readOnly}
              dragDeviceId={drag?.payload.type === "device" ? drag.payload.device.id : null}
              onDragStart={(e, d) => startDrag(e, { type: "device", device: d }, "tray")}
              onRemove={readOnly ? undefined : removeDevice}
            />
            <TraySection
              title="No rack assigned"
              devices={trayNoRack}
              readOnly={readOnly}
              dragDeviceId={drag?.payload.type === "device" ? drag.payload.device.id : null}
              onDragStart={(e, d) => startDrag(e, { type: "device", device: d }, "tray")}
            />
            {!readOnly && (
              <div className="text-muted text-[10px]">
                Drag a device or rack item onto the front or rear to place it. Red preview means
                the position conflicts with another object on that side (full-depth objects block
                both sides) or is out of range. Drag a placed device onto this list to remove it
                from the rack.
              </div>
            )}
          </div>
        </div>
      </div>

      <RackItemDialog
        open={itemDialog.open}
        onClose={closeItemDialog}
        rackId={rack.id}
        heightU={heightU}
        item={itemDialog.item}
        defaultPos={defaultItemPos}
        defaultKind={itemDialog.kind}
        placements={placements}
        items={rackItems}
        readOnly={readOnly}
      />
    </div>
  );
}

function TraySection({
  title,
  devices,
  readOnly,
  dragDeviceId,
  onDragStart,
  onRemove,
}: {
  title: string;
  devices: TopologyNode[];
  readOnly: boolean;
  dragDeviceId: number | null;
  onDragStart: (e: React.PointerEvent, device: TopologyNode) => void;
  // Per-item "remove from rack" action (devices assigned to this rack
  // without a U position); omitted for the no-rack list and read-only mode.
  onRemove?: (device: TopologyNode) => void;
}) {
  return (
    <div className="border border-line rounded-card bg-panel">
      <div className="px-3 py-2 border-b border-line text-[11px] font-semibold text-muted">
        {title} ({devices.length})
      </div>
      {devices.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-muted">No devices</div>
      ) : (
        <div className="flex flex-col p-1.5 gap-1 max-h-[320px] overflow-y-auto">
          {devices.map((d) => {
            const ping = d.ping_status || "unknown";
            const status = ping === "online" ? "up" : ping === "offline" ? "down" : "unknown";
            return (
              <div
                key={d.id}
                data-testid={`tray-item-${d.id}`}
                title={readOnly ? d.ip : `${d.ip} - drag onto the rack to place`}
                onPointerDown={(e) => onDragStart(e, d)}
                className={`flex items-center gap-2 px-2 py-1.5 rounded border border-line bg-panel-2 text-[11px] select-none ${
                  readOnly ? "" : "cursor-grab active:cursor-grabbing hover:border-accent"
                } ${dragDeviceId === d.id ? "opacity-40" : ""}`}
                style={{ touchAction: "none" }}
              >
                <StatusDot status={status} className="shrink-0" />
                <VendorBadge vendor={d.vendor} />
                <span className="text-primary truncate">{deviceDisplayName(d)}</span>
                <span className="text-muted text-[10px] ml-auto shrink-0">
                  {deviceUHeight(d)}U
                </span>
                {!readOnly && onRemove && <RemoveFromRackButton device={d} onRemove={() => onRemove(d)} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
