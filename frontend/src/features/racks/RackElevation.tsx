// ── RackElevation ────────────────────────────────────────────────────────────
// True rack-elevation view: vertical frame with U scale (U1 at the bottom),
// device faceplates spanning the interior, pointer-based drag-and-drop
// placement and an unassigned-devices tray.

import { useCallback, useMemo, useRef } from "react";
import { VENDOR_ICON, VENDOR_LABEL, speedColor } from "../../theme/visual";
import { Badge, StatusDot } from "../../components/ui";
import type { RackInfo, TopologyNode } from "../../types";
import {
  U_PX,
  deviceUHeight,
  placementsFromNodes,
  rackHeightU,
  rowFromTop,
  usedUnits,
} from "./rackLayout";
import { useRackDrag, useRackLayout } from "./useRackLayout";
import { useInspector } from "../../hooks/useInspector";

interface RackElevationProps {
  rack: RackInfo;
  nodes: TopologyNode[];
  readOnly?: boolean;
}

// ── Compact port strip (scaled-down variant of the SwitchPanel port grid) ───
function PortStrip({ device }: { device: TopologyNode }) {
  const ports = useMemo(
    () =>
      [...device.ports]
        .sort((a, b) => (a.if_index || 0) - (b.if_index || 0))
        .slice(0, device.total_ports || device.ports.length),
    [device.ports, device.total_ports],
  );
  if (ports.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-px items-center overflow-hidden max-h-full flex-1 min-w-0">
      {ports.map((p) => {
        const active = p.oper_status === 1;
        return (
          <span
            key={p.id ?? p.if_index ?? p.port_id}
            title={`${p.if_descr ?? p.name} - ${active ? "up" : "down"}${
              p.endpoint_count ? ` - ${p.endpoint_count} endpoint(s)` : ""
            }`}
            className="inline-block w-[5px] h-[5px] rounded-[1px] shrink-0"
            style={{ backgroundColor: active ? speedColor(p.speed_mbps ?? p.speed ?? 0) : "var(--line-strong)" }}
          />
        );
      })}
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
    "w-4 h-4 inline-flex items-center justify-center rounded border border-line-strong text-muted hover:text-primary hover:border-accent disabled:opacity-30 disabled:hover:text-muted disabled:hover:border-line-strong cursor-pointer disabled:cursor-default text-[10px] leading-none";
  return (
    <div className="flex items-center gap-1 shrink-0" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={`Decrease U height of ${device.sys_name}`}
        className={btn}
        disabled={readOnly || uHeight <= 1}
        onClick={() => onChange(uHeight - 1)}
      >
        -
      </button>
      <span className="text-[10px] text-muted w-6 text-center">{uHeight}U</span>
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

// ── Device faceplate ─────────────────────────────────────────────────────────
function Faceplate({
  device,
  readOnly,
  dragging,
  heightU,
  onPointerDown,
  onUHeight,
  onOpen,
}: {
  device: TopologyNode;
  readOnly: boolean;
  dragging: boolean;
  heightU: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onUHeight: (uHeight: number) => void;
  onOpen: () => void;
}) {
  const ping = device.ping_status || "unknown";
  const status = ping === "online" ? "up" : ping === "offline" ? "down" : "unknown";
  const vendor = VENDOR_ICON[device.vendor] ?? VENDOR_ICON.generic;
  const name = device.sys_name || device.hostname || device.ip;
  return (
    <div
      data-testid={`faceplate-${device.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${name} - open details`}
      title={readOnly ? "Click to open details" : "Click to open details, drag to move"}
      onPointerDown={onPointerDown}
      // Read-only racks have no drag gesture, so a plain click opens details.
      // Editable racks open via the click-vs-drag threshold in useRackDrag.
      onClick={readOnly ? onOpen : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`flex items-center gap-2 px-2 h-full w-full rounded border bg-panel-2 overflow-hidden select-none transition-colors duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
        readOnly
          ? "border-line cursor-pointer hover:border-accent"
          : "border-line-strong cursor-grab active:cursor-grabbing hover:border-accent"
      } ${dragging ? "opacity-40" : ""}`}
      style={{ touchAction: "none" }}
    >
      <StatusDot status={status} className="shrink-0" />
      <span className="text-[10px] text-muted shrink-0" title={VENDOR_LABEL[device.vendor] ?? device.vendor}>
        {vendor}
      </span>
      <span className="text-primary text-[11px] font-semibold truncate shrink-0 max-w-[160px]">
        {name}
      </span>
      {ping === "online" && device.ping_rtt_ms != null && (
        <span className="text-[10px] text-muted shrink-0">{device.ping_rtt_ms}ms</span>
      )}
      <PortStrip device={device} />
      <UHeightControl device={device} heightU={heightU} readOnly={readOnly} onChange={onUHeight} />
    </div>
  );
}

// ── RackElevation ────────────────────────────────────────────────────────────
export default function RackElevation({ rack, nodes, readOnly = false }: RackElevationProps) {
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
        {/* Rack frame */}
        <div className="flex shrink-0">
          {/* Left U scale */}
          <div className="flex flex-col w-7 shrink-0">
            {scaleRows.map((u) => (
              <div
                key={u}
                className="flex items-center justify-end pr-1 text-[9px] text-muted border-b border-line"
                style={{ height: U_PX }}
              >
                {u}
              </div>
            ))}
          </div>

          {/* Rack interior */}
          <div
            ref={bodyRef}
            data-testid="rack-body"
            className="relative w-[480px] max-w-full border-x-2 border-line-strong bg-panel rounded-sm"
            style={{ height: heightU * U_PX }}
          >
            {/* Empty slot lines */}
            {Array.from({ length: heightU }, (_, i) => (
              <div
                key={i}
                className="absolute inset-x-0 border-b border-line/60"
                style={{ top: i * U_PX, height: U_PX }}
              />
            ))}

            {/* Placed devices */}
            {placed.map((device) => {
              const pl = placementById.get(device.id);
              const uHeight = pl?.uHeight ?? deviceUHeight(device);
              const pos = pl?.pos ?? (device.rack_u_position as number);
              return (
                <div
                  key={device.id}
                  className="absolute px-1"
                  style={{
                    top: rowFromTop(heightU, pos, uHeight) * U_PX + 1,
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
                  />
                </div>
              );
            })}

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

          {/* Right U scale */}
          <div className="flex flex-col w-7 shrink-0">
            {scaleRows.map((u) => (
              <div
                key={u}
                className="flex items-center justify-start pl-1 text-[9px] text-muted border-b border-line"
                style={{ height: U_PX }}
              >
                {u}
              </div>
            ))}
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
    <div className="border border-line rounded-lg bg-panel">
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
                <span className="text-muted text-[10px] shrink-0">
                  {VENDOR_ICON[d.vendor] ?? VENDOR_ICON.generic}
                </span>
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
