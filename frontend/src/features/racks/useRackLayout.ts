// ── Rack layout mutations + pointer-based drag-and-drop ─────────────────────
// Placement moves inside a rack go to PATCH /api/racks/{id}/layout with the
// full recomputed layout (including every device's rack_side / full_depth);
// rack membership changes (assign from the no-rack tray, remove from the
// rack, u_height and full_depth edits) go to
// PATCH /api/topology/devices/{id}/meta.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, extractErrorMessage } from "../../api";
import { queryKeys } from "../../hooks/api";
import { useToast } from "../../components/ToastProvider";
import type { RackItem, RackItemKind, RackSide, TopologyData, TopologyNode } from "../../types";
import {
  RACK_SIDES,
  buildLayoutEntries,
  computeDropTarget,
  deviceUHeight,
  fullDepthOf,
  isClickGesture,
  placementsFromNodes,
  rackHeightU,
  sideOf,
  type DropTarget,
  type UBlock,
} from "./rackLayout";

interface LayoutContext {
  previous: TopologyData | undefined;
}

function patchTopologyNode(
  data: TopologyData | undefined,
  deviceId: number,
  patch: Partial<TopologyNode>,
): TopologyData | undefined {
  if (!data) return data;
  return {
    ...data,
    nodes: data.nodes.map((n) => (n.id === deviceId ? { ...n, ...patch } : n)),
  };
}

interface PlaceVars {
  device: TopologyNode;
  pos: number;
  uHeight: number;
  side: RackSide;
}

export function useRackLayout(rackId: number) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  // Shared optimistic-update plumbing: snapshot the topology query, apply a
  // local patch, roll back and toast on error, refetch when settled.
  const optimisticNodePatch = useCallback(
    (deviceId: number, patch: Partial<TopologyNode>): LayoutContext => {
      const previous = queryClient.getQueryData<TopologyData>(queryKeys.topology);
      queryClient.setQueryData<TopologyData>(queryKeys.topology, (old) =>
        patchTopologyNode(old, deviceId, patch),
      );
      return { previous };
    },
    [queryClient],
  );

  const onError = useCallback(
    (ex: unknown, context: LayoutContext | undefined) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.topology, context.previous);
      }
      addToast(`Rack layout not saved: ${extractErrorMessage(ex)}`, "error");
    },
    [queryClient, addToast],
  );

  const onSettled = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.topology });
    void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
  }, [queryClient]);

  // Move a device that already belongs to this rack to a new U position
  // and/or side. Sends the full recomputed layout in one transaction.
  const moveMutation = useMutation({
    mutationFn: async ({ device, pos, uHeight, side }: PlaceVars) => {
      const data = queryClient.getQueryData<TopologyData>(queryKeys.topology);
      const rack = data?.racks.find((r) => r.id === rackId);
      const fullDepth = fullDepthOf(device);
      const placements = placementsFromNodes(data?.nodes ?? [], rackId, rackHeightU(rack ?? {})).map((p) =>
        p.deviceId === device.id ? { ...p, pos, uHeight, side, fullDepth } : p,
      );
      if (!placements.some((p) => p.deviceId === device.id)) {
        placements.push({ deviceId: device.id, pos, uHeight, side, fullDepth });
      }
      await api.patch(`/api/racks/${rackId}/layout`, { entries: buildLayoutEntries(placements) });
    },
    onMutate: ({ device, pos, uHeight, side }) =>
      optimisticNodePatch(device.id, { rack_u_position: pos, u_height: uHeight, rack_side: side }),
    onError: (ex, _vars, context) => onError(ex, context),
    onSettled,
  });

  // Assign a rack-less device into this rack at a U position and side (meta
  // endpoint, because rack membership changes). full_depth is kept as is.
  const assignMutation = useMutation({
    mutationFn: async ({ device, pos, uHeight, side }: PlaceVars) => {
      await api.patch(`/api/topology/devices/${device.id}/meta`, {
        rack_id: rackId,
        rack_u_position: pos,
        u_height: uHeight,
        rack_side: side,
      });
    },
    onMutate: ({ device, pos, uHeight, side }) =>
      optimisticNodePatch(device.id, { rack_id: rackId, rack_u_position: pos, u_height: uHeight, rack_side: side }),
    onError: (ex, _vars, context) => onError(ex, context),
    onSettled,
  });

  // Take a device out of the rack entirely (back to "No rack assigned"):
  // explicit nulls clear both the rack membership and the U slot.
  const removeMutation = useMutation({
    mutationFn: async ({ device }: { device: TopologyNode }) => {
      await api.patch(`/api/topology/devices/${device.id}/meta`, {
        rack_id: null,
        rack_u_position: null,
      });
    },
    onMutate: ({ device }) => optimisticNodePatch(device.id, { rack_id: null, rack_u_position: null }),
    onError: (ex, _vars, context) => onError(ex, context),
    onSettled,
  });

  // Change a device's U height.
  const heightMutation = useMutation({
    mutationFn: async ({ device, uHeight }: { device: TopologyNode; uHeight: number }) => {
      await api.patch(`/api/topology/devices/${device.id}/meta`, { u_height: uHeight });
    },
    onMutate: ({ device, uHeight }) => optimisticNodePatch(device.id, { u_height: uHeight }),
    onError: (ex, _vars, context) => onError(ex, context),
    onSettled,
  });

  // Toggle whether a device blocks both rack faces.
  const fullDepthMutation = useMutation({
    mutationFn: async ({ device, fullDepth }: { device: TopologyNode; fullDepth: boolean }) => {
      await api.patch(`/api/topology/devices/${device.id}/meta`, { full_depth: fullDepth });
    },
    onMutate: ({ device, fullDepth }) => optimisticNodePatch(device.id, { full_depth: fullDepth }),
    onError: (ex, _vars, context) => onError(ex, context),
    onSettled,
  });

  // Stable callback identities: React Query's `mutate` is bound to a
  // persistent observer, so these wrappers do not change between renders and
  // useRackDrag does not re-register its window listeners every render.
  const moveDevice = useCallback(
    (device: TopologyNode, pos: number, uHeight: number, side: RackSide = sideOf(device)) =>
      moveMutation.mutate({ device, pos, uHeight, side }),
    [moveMutation.mutate],
  );
  const assignDevice = useCallback(
    (device: TopologyNode, pos: number, uHeight: number, side: RackSide = sideOf(device)) =>
      assignMutation.mutate({ device, pos, uHeight, side }),
    [assignMutation.mutate],
  );
  const setUHeight = useCallback(
    (device: TopologyNode, uHeight: number) =>
      heightMutation.mutate({ device, uHeight }),
    [heightMutation.mutate],
  );
  const setFullDepth = useCallback(
    (device: TopologyNode, fullDepth: boolean) => fullDepthMutation.mutate({ device, fullDepth }),
    [fullDepthMutation.mutate],
  );
  const removeDevice = useCallback(
    (device: TopologyNode) => removeMutation.mutate({ device }),
    [removeMutation.mutate],
  );

  return {
    moveDevice,
    assignDevice,
    setUHeight,
    setFullDepth,
    removeDevice,
    saving:
      moveMutation.isPending ||
      assignMutation.isPending ||
      heightMutation.isPending ||
      fullDepthMutation.isPending ||
      removeMutation.isPending,
  };
}

// ── Drag state ───────────────────────────────────────────────────────────────

// What is being dragged: a device (faceplate or tray entry), an existing rack
// item (its plate in the elevation) or a new item from the palette.
export type RackDragPayload =
  | { type: "device"; device: TopologyNode }
  | { type: "item"; item: RackItem }
  | { type: "palette"; kind: RackItemKind; uHeight: number };

export type RackDragSource = "rack" | "tray" | "palette";

export interface RackDragState {
  payload: RackDragPayload;
  source: RackDragSource;
  uHeight: number;
  fullDepth: boolean;
  pointer: { x: number; y: number };
  origin: { x: number; y: number }; // pointer position at pointerdown
  target: DropTarget | null; // null while the pointer is outside both rack bodies
  // True while a placed device (source "rack") hovers the tray drop zone.
  overTray: boolean;
}

// Stable identity of a drag payload, e.g. to dim the source element.
export function dragPayloadKey(payload: RackDragPayload): string {
  if (payload.type === "device") return `device-${payload.device.id}`;
  if (payload.type === "item") return `item-${payload.item.id}`;
  return `palette-${payload.kind}`;
}

function payloadExtent(payload: RackDragPayload): { uHeight: number; fullDepth: boolean } {
  if (payload.type === "device") return { uHeight: deviceUHeight(payload.device), fullDepth: fullDepthOf(payload.device) };
  if (payload.type === "item") return { uHeight: Math.max(1, payload.item.u_height), fullDepth: fullDepthOf(payload.item) };
  return { uHeight: Math.max(1, payload.uHeight), fullDepth: false };
}

export type RackBodyRefs = Record<RackSide, RefObject<HTMLDivElement | null>>;

interface UseRackDragOptions {
  rackId: number;
  heightU: number;
  nodes: TopologyNode[];
  // Ranges occupied by rack items (with their id); drops conflicting with
  // them are invalid. A dragged item never conflicts with itself.
  blocked?: (UBlock & { id?: number })[];
  // One rack body per face; the body under the pointer picks the drop side.
  bodyRefs: RackBodyRefs;
  // Tray area: releasing a placed device over it removes it from the rack.
  trayRef?: RefObject<HTMLDivElement | null>;
  readOnly: boolean;
  onDrop: (payload: RackDragPayload, source: RackDragSource, target: DropTarget, uHeight: number) => void;
  // Called when a placed device is released over the tray (trayRef).
  onRemove?: (device: TopologyNode) => void;
  // Called instead of a drop when the press moved less than the click
  // threshold (see isClickGesture), e.g. to open the inspector or a dialog.
  onClick?: (payload: RackDragPayload, source: RackDragSource) => void;
}

// Pointer-event drag-and-drop: grab a faceplate, item plate, tray entry or
// palette entry, preview a ghost snapped to the U grid of the face under the
// pointer (red when invalid), commit on release. A release within
// CLICK_MOVE_THRESHOLD_PX of the press point is a click, not a drop. A placed
// device released over the tray is removed from the rack; a release anywhere
// else outside the rack cancels.
const NO_BLOCKS: (UBlock & { id?: number })[] = [];

// Horizontal slack around a rack body that still counts as "over" it.
const BODY_SLACK_PX = 60;

function pointInside(el: HTMLElement | null | undefined, x: number, y: number): boolean {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function useRackDrag({
  rackId,
  heightU,
  nodes,
  blocked = NO_BLOCKS,
  bodyRefs,
  trayRef,
  readOnly,
  onDrop,
  onRemove,
  onClick,
}: UseRackDragOptions) {
  const [drag, setDrag] = useState<RackDragState | null>(null);
  const dragRef = useRef<RackDragState | null>(null);
  dragRef.current = drag;

  const startDrag = useCallback(
    (e: React.PointerEvent, payload: RackDragPayload, source: RackDragSource) => {
      if (readOnly || e.button !== 0) return;
      e.preventDefault();
      const { uHeight, fullDepth } = payloadExtent(payload);
      setDrag({
        payload,
        source,
        uHeight,
        fullDepth,
        pointer: { x: e.clientX, y: e.clientY },
        origin: { x: e.clientX, y: e.clientY },
        target: null,
        overTray: false,
      });
    },
    [readOnly],
  );

  useEffect(() => {
    if (!drag) return;

    const placements = placementsFromNodes(nodes, rackId, heightU);

    function onMove(e: PointerEvent) {
      const current = dragRef.current;
      let target: DropTarget | null = null;
      if (current) {
        // Pick the face whose body is closest to the pointer horizontally
        // (0 when inside), within the slack and the body's vertical extent.
        let best: { side: RackSide; rect: DOMRect; dist: number } | null = null;
        for (const side of RACK_SIDES) {
          const body = bodyRefs[side].current;
          if (!body) continue;
          const rect = body.getBoundingClientRect();
          if (e.clientY < rect.top || e.clientY > rect.bottom) continue;
          const dist = e.clientX < rect.left ? rect.left - e.clientX : e.clientX > rect.right ? e.clientX - rect.right : 0;
          if (dist > BODY_SLACK_PX) continue;
          if (!best || dist < best.dist) best = { side, rect, dist };
        }
        if (best) {
          const { uHeight, fullDepth, payload } = current;
          const row = Math.max(
            0,
            Math.min(heightU - uHeight, Math.floor((e.clientY - best.rect.top) / (best.rect.height / heightU))),
          );
          const deviceId = payload.type === "device" ? payload.device.id : -1;
          const itemId = payload.type === "item" ? payload.item.id : null;
          const others = itemId == null ? blocked : blocked.filter((b) => b.id !== itemId);
          target = computeDropTarget(placements, deviceId, row, uHeight, heightU, others, {
            side: best.side,
            fullDepth,
          });
        }
      }
      // The rack bodies win over the tray; only placed devices can be dropped
      // onto the tray (tray items are already out of the elevation).
      const overTray =
        target == null &&
        current?.source === "rack" &&
        current.payload.type === "device" &&
        pointInside(trayRef?.current, e.clientX, e.clientY);
      setDrag((d) => (d ? { ...d, pointer: { x: e.clientX, y: e.clientY }, target, overTray } : d));
    }

    function onUp(e: PointerEvent) {
      const current = dragRef.current;
      if (current && e.type === "pointerup" && isClickGesture(current.origin, { x: e.clientX, y: e.clientY })) {
        // Sub-threshold press: a click, never a (no-op) re-drop.
        setDrag(null);
        onClick?.(current.payload, current.source);
        return;
      }
      if (current?.target?.valid) {
        onDrop(current.payload, current.source, current.target, current.uHeight);
      } else if (current && e.type === "pointerup" && current.overTray && current.payload.type === "device") {
        onRemove?.(current.payload.device);
      }
      setDrag(null);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag != null, nodes, blocked, rackId, heightU, bodyRefs, trayRef, onDrop, onRemove, onClick]); // eslint-disable-line react-hooks/exhaustive-deps

  return { drag, startDrag };
}
