// ── Rack layout mutations + pointer-based drag-and-drop ─────────────────────
// Placement moves inside a rack go to PATCH /api/racks/{id}/layout with the
// full recomputed layout; rack membership changes (assign from the no-rack
// tray, u_height edits) go to PATCH /api/topology/devices/{id}/meta.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, extractErrorMessage } from "../../api";
import { queryKeys } from "../../hooks/api";
import { useToast } from "../../components/ToastProvider";
import type { TopologyData, TopologyNode } from "../../types";
import {
  buildLayoutEntries,
  computeDropTarget,
  deviceUHeight,
  placementsFromNodes,
  rackHeightU,
  type DropTarget,
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

  // Move a device that already belongs to this rack to a new U position.
  // Sends the full recomputed layout in one transaction.
  const moveMutation = useMutation({
    mutationFn: async ({
      device,
      pos,
      uHeight,
    }: {
      device: TopologyNode;
      pos: number;
      uHeight: number;
    }) => {
      const data = queryClient.getQueryData<TopologyData>(queryKeys.topology);
      const rack = data?.racks.find((r) => r.id === rackId);
      const placements = placementsFromNodes(data?.nodes ?? [], rackId, rackHeightU(rack ?? {})).map((p) =>
        p.deviceId === device.id ? { ...p, pos, uHeight } : p,
      );
      if (!placements.some((p) => p.deviceId === device.id)) {
        placements.push({ deviceId: device.id, pos, uHeight });
      }
      await api.patch(`/api/racks/${rackId}/layout`, { entries: buildLayoutEntries(placements) });
    },
    onMutate: ({ device, pos, uHeight }) =>
      optimisticNodePatch(device.id, { rack_u_position: pos, u_height: uHeight }),
    onError: (ex, _vars, context) => onError(ex, context),
    onSettled,
  });

  // Assign a rack-less device into this rack at a U position (meta endpoint,
  // because rack membership changes).
  const assignMutation = useMutation({
    mutationFn: async ({
      device,
      pos,
      uHeight,
    }: {
      device: TopologyNode;
      pos: number;
      uHeight: number;
    }) => {
      await api.patch(`/api/topology/devices/${device.id}/meta`, {
        rack_id: rackId,
        rack_u_position: pos,
        u_height: uHeight,
      });
    },
    onMutate: ({ device, pos, uHeight }) =>
      optimisticNodePatch(device.id, { rack_id: rackId, rack_u_position: pos, u_height: uHeight }),
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

  // Stable callback identities: React Query's `mutate` is bound to a
  // persistent observer, so these wrappers do not change between renders and
  // useRackDrag does not re-register its window listeners every render.
  const moveDevice = useCallback(
    (device: TopologyNode, pos: number, uHeight: number) =>
      moveMutation.mutate({ device, pos, uHeight }),
    [moveMutation.mutate],
  );
  const assignDevice = useCallback(
    (device: TopologyNode, pos: number, uHeight: number) =>
      assignMutation.mutate({ device, pos, uHeight }),
    [assignMutation.mutate],
  );
  const setUHeight = useCallback(
    (device: TopologyNode, uHeight: number) =>
      heightMutation.mutate({ device, uHeight }),
    [heightMutation.mutate],
  );

  return {
    moveDevice,
    assignDevice,
    setUHeight,
    saving: moveMutation.isPending || assignMutation.isPending || heightMutation.isPending,
  };
}

// ── Drag state ───────────────────────────────────────────────────────────────

export interface RackDragState {
  device: TopologyNode;
  source: "rack" | "tray";
  uHeight: number;
  pointer: { x: number; y: number };
  target: DropTarget | null; // null while the pointer is outside the rack body
}

interface UseRackDragOptions {
  rackId: number;
  heightU: number;
  nodes: TopologyNode[];
  bodyRef: RefObject<HTMLDivElement | null>;
  readOnly: boolean;
  onDrop: (device: TopologyNode, source: "rack" | "tray", pos: number, uHeight: number) => void;
}

// Pointer-event drag-and-drop: grab a faceplate or tray item, preview a ghost
// snapped to the U grid (red when invalid), commit on release.
export function useRackDrag({ rackId, heightU, nodes, bodyRef, readOnly, onDrop }: UseRackDragOptions) {
  const [drag, setDrag] = useState<RackDragState | null>(null);
  const dragRef = useRef<RackDragState | null>(null);
  dragRef.current = drag;

  const startDrag = useCallback(
    (e: React.PointerEvent, device: TopologyNode, source: "rack" | "tray") => {
      if (readOnly || e.button !== 0) return;
      e.preventDefault();
      setDrag({
        device,
        source,
        uHeight: deviceUHeight(device),
        pointer: { x: e.clientX, y: e.clientY },
        target: null,
      });
    },
    [readOnly],
  );

  useEffect(() => {
    if (!drag) return;

    const placements = placementsFromNodes(nodes, rackId, heightU);

    function onMove(e: PointerEvent) {
      const body = bodyRef.current;
      let target: DropTarget | null = null;
      if (body) {
        const rect = body.getBoundingClientRect();
        if (
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom &&
          e.clientX >= rect.left - 60 &&
          e.clientX <= rect.right + 60
        ) {
          const current = dragRef.current;
          const uHeight = current?.uHeight ?? 1;
          const row = Math.max(
            0,
            Math.min(heightU - uHeight, Math.floor((e.clientY - rect.top) / (rect.height / heightU))),
          );
          target = computeDropTarget(
            placements,
            current?.device.id ?? -1,
            row,
            uHeight,
            heightU,
          );
        }
      }
      setDrag((d) => (d ? { ...d, pointer: { x: e.clientX, y: e.clientY }, target } : d));
    }

    function onUp() {
      const current = dragRef.current;
      if (current?.target?.valid) {
        onDrop(current.device, current.source, current.target.pos, current.uHeight);
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
  }, [drag != null, nodes, rackId, heightU, bodyRef, onDrop]); // eslint-disable-line react-hooks/exhaustive-deps

  return { drag, startDrag };
}
