// ── RackElevation ────────────────────────────────────────────────────────────
// True rack-elevation view drawn as a technical illustration of a 19" rack:
// square-hole side rails with U numbers (U1 at the bottom), blanking plates in
// empty slots, device faceplates with rack ears, a status LED and stylized port
// tiles (filled = up in the speed color, hollow = down, dot = endpoints), a
// label column right of the rack (device name + model as plan annotations with
// leader lines), a port legend, pointer-based drag-and-drop placement and an
// unassigned tray.
// Faceplate styling lives in the "Rack faceplates (phase 4)" block of
// index.css; all colors come from theme tokens or theme/visual.ts.

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { speedColor } from "../../theme/visual";
import { Badge, StatusDot } from "../../components/ui";
import VendorBadge from "../../components/map/VendorBadge";
import type { PortInfo, RackInfo, TopologyNode } from "../../types";
import {
  U_PX,
  deviceUHeight,
  placementsFromNodes,
  rackHeightU,
  rowFromTop,
  usedUnits,
} from "./rackLayout";
import {
  activityTiming,
  layoutPortSockets,
  portSpeedMbps,
  portStatus,
  portTitle,
  type SocketGroup,
} from "./portSockets";
import { useRackDrag, useRackLayout } from "./useRackLayout";
import { useInspector } from "../../hooks/useInspector";

interface RackElevationProps {
  rack: RackInfo;
  nodes: TopologyNode[];
  readOnly?: boolean;
  // Subtle LED blink on up ports (user toggle, off under reduced motion).
  activity?: boolean;
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
function RackRail({ side, rows }: { side: "left" | "right"; rows: number[] }) {
  const holes = (
    <span className="rack-rail-holes" aria-hidden="true">
      <span className="rack-rail-hole" />
      <span className="rack-rail-hole" />
      <span className="rack-rail-hole" />
    </span>
  );
  return (
    <div className={`rack-rail rack-rail-${side} flex flex-col w-7 shrink-0`} data-testid={`rack-rail-${side}`}>
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
  const max = Math.min(4, heightU);
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

function deviceName(device: TopologyNode): string {
  return device.sys_name || device.hostname || device.ip;
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
  onOpen,
  activity,
  highlighted,
  onHighlight,
}: {
  device: TopologyNode;
  readOnly: boolean;
  dragging: boolean;
  heightU: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onUHeight: (uHeight: number) => void;
  onOpen: () => void;
  activity: boolean;
  // Shared hover/focus highlight with the device's label in the label column.
  highlighted: boolean;
  onHighlight: (on: boolean) => void;
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
      className={`rack-plate flex items-stretch h-full w-full rounded-[2px] border overflow-hidden select-none transition-colors duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${border} ${
        readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
      } ${dragging ? "opacity-40" : ""}`}
      style={{ touchAction: "none" }}
    >
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
        <PortBlock
          deviceId={device.id}
          ports={device.ports}
          totalPorts={device.total_ports}
          activity={activity}
        />
        <UHeightControl device={device} heightU={heightU} readOnly={readOnly} onChange={onUHeight} />
      </div>
      <RackEar side="right" />
    </div>
  );
}

// ── RackElevation ────────────────────────────────────────────────────────────
export default function RackElevation({ rack, nodes, readOnly = false, activity = false }: RackElevationProps) {
  const heightU = rackHeightU(rack);
  const bodyRef = useRef<HTMLDivElement>(null);

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

  const used = usedUnits(placements);

  const { moveDevice, assignDevice, setUHeight, saving } = useRackLayout(rack.id);

  const onDrop = useCallback(
    (device: TopologyNode, source: "rack" | "tray", pos: number, uHeight: number) => {
      if (source === "tray" && device.rack_id !== rack.id) {
        assignDevice(device, pos, uHeight);
      } else {
        moveDevice(device, pos, uHeight);
      }
    },
    [assignDevice, moveDevice, rack.id],
  );

  const { open: openInspector } = useInspector();
  const openDevice = useCallback((device: TopologyNode) => openInspector("device", device.id), [openInspector]);

  const { drag, startDrag } = useRackDrag({
    rackId: rack.id,
    heightU,
    nodes,
    bodyRef,
    readOnly,
    onDrop,
    onClick: openDevice,
  });

  const scaleRows = Array.from({ length: heightU }, (_, i) => heightU - i); // top row shows heightU

  // Pixel top of every placed device, shared by its faceplate and its label.
  const placedRows = useMemo(
    () =>
      placed.map((device) => {
        const pl = placementById.get(device.id);
        const uHeight = pl?.uHeight ?? deviceUHeight(device);
        const pos = pl?.pos ?? (device.rack_u_position as number);
        return { device, uHeight, top: rowFromTop(heightU, pos, uHeight) * U_PX + 1 };
      }),
    [placed, placementById, heightU],
  );

  // Shared hover/focus highlight between a faceplate and its label. Leaving
  // one element only clears the highlight it set, so moving between the
  // faceplate and the label never flickers another device. Suppressed while
  // a drag is in progress.
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const highlight = useCallback((id: number, on: boolean) => {
    setHoveredId((cur) => (on ? id : cur === id ? null : cur));
  }, []);
  const highlightId = drag ? null : hoveredId;

  return (
    <div className="flex flex-col gap-3">
      {/* Rack header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-primary font-semibold text-sm">{rack.label}</span>
        {rack.room && <span className="text-muted text-[11px]">{rack.room}</span>}
        <Badge tone="accent">{heightU}U</Badge>
        <span className="text-muted text-[11px]">
          {used}/{heightU} U used - {heightU - used} U free
        </span>
        {saving && <span className="text-muted text-[11px]">Saving...</span>}
        {readOnly && (
          <span className="text-warning text-[11px]">
            View-only: sign in as operator or admin to rearrange devices
          </span>
        )}
      </div>

      <div className="flex gap-4 items-start flex-wrap">
        {/* Rack + label column share one horizontal scroll container so label
            rows stay aligned with their faceplates on narrow screens. */}
        <div data-testid="rack-scroll" className="min-w-0 max-w-full overflow-x-auto pb-1">
        <div className="flex items-start w-max">
        {/* Rack frame: top cap, rails + interior, bottom cap */}
        <div className="rack-frame flex flex-col shrink-0">
          <div className="rack-cap" aria-hidden="true" />
          <div className="flex">
          {/* Left rail with U scale */}
          <RackRail side="left" rows={scaleRows} />

          {/* Rack interior */}
          <div
            ref={bodyRef}
            data-testid="rack-body"
            className="rack-interior relative w-[480px]"
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

            {/* Placed devices */}
            {placedRows.map(({ device, top, uHeight }) => (
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
                  dragging={drag?.device.id === device.id}
                  heightU={heightU}
                  onPointerDown={(e) => startDrag(e, device, "rack")}
                  onUHeight={(h) => setUHeight(device, h)}
                  onOpen={() => openDevice(device)}
                  activity={activity}
                  highlighted={highlightId === device.id}
                  onHighlight={(on) => highlight(device.id, on)}
                />
              </div>
            ))}

            {/* Drop ghost */}
            {drag?.target && (
              <div
                data-testid="drop-ghost"
                data-valid={drag.target.valid ? "1" : "0"}
                className={`absolute inset-x-1 rounded pointer-events-none border ${
                  drag.target.valid
                    ? "border-accent bg-accent/15"
                    : "border-danger bg-danger/15"
                }`}
                style={{
                  top: drag.target.row * U_PX + 1,
                  height: drag.uHeight * U_PX - 2,
                }}
              >
                <span className="absolute right-1 top-0 text-[9px] text-muted">
                  U{drag.target.pos}
                </span>
              </div>
            )}
          </div>

          {/* Right rail with U scale */}
          <RackRail side="right" rows={scaleRows} />
          </div>
          <div className="rack-cap" aria-hidden="true" />
          <div className="pt-2">
            <PortLegend />
          </div>
        </div>

        {/* Label column: one annotation per placed device, offset by the top
            cap so each label top equals its faceplate top. The dragged
            device's label is dimmed in place (like its faceplate) instead of
            following the ghost; other labels stay put. */}
        <div
          data-testid="rack-label-column"
          className="relative shrink-0"
          style={{ marginTop: RACK_CAP_PX, height: heightU * U_PX, width: "clamp(180px, 24vw, 320px)" }}
        >
          {placedRows.map(({ device, top }) => (
            <RackLabel
              key={device.id}
              device={device}
              top={top}
              highlighted={highlightId === device.id}
              dragging={drag?.device.id === device.id}
              onHighlight={(on) => highlight(device.id, on)}
              onOpen={() => openDevice(device)}
            />
          ))}
        </div>
        </div>
        </div>

        {/* Unassigned devices tray */}
        <div className="flex flex-col gap-3 min-w-[240px] flex-1 max-w-[360px]">
          <TraySection
            title="Unplaced in this rack"
            devices={trayInRack}
            readOnly={readOnly}
            dragDeviceId={drag?.device.id ?? null}
            onDragStart={(e, d) => startDrag(e, d, "tray")}
          />
          <TraySection
            title="No rack assigned"
            devices={trayNoRack}
            readOnly={readOnly}
            dragDeviceId={drag?.device.id ?? null}
            onDragStart={(e, d) => startDrag(e, d, "tray")}
          />
          {!readOnly && (
            <div className="text-muted text-[10px]">
              Drag a device onto the rack to place it. Red preview means the position
              overlaps another device or is out of range.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TraySection({
  title,
  devices,
  readOnly,
  dragDeviceId,
  onDragStart,
}: {
  title: string;
  devices: TopologyNode[];
  readOnly: boolean;
  dragDeviceId: number | null;
  onDragStart: (e: React.PointerEvent, device: TopologyNode) => void;
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
                <span className="text-primary truncate">{d.sys_name || d.hostname || d.ip}</span>
                <span className="text-muted text-[10px] ml-auto shrink-0">
                  {deviceUHeight(d)}U
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
