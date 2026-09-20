// ── Dagre auto-layout ────────────────────────────────────────────────────────
// Shared node dimensions plus dagre helpers. Two modes:
//  - partial: only nodes without stored positions get laid out; positioned
//    nodes keep their coordinates and the fresh cluster is placed beside them.
//  - full: every node is re-laid-out (Auto-Layout toolbar button).

import dagre from "dagre";

export const RACK_COLLAPSED_SIZE = { width: 176, height: 100 } as const;
export const DEVICE_NODE_SIZE = { width: 216, height: 76 } as const;

// Expanded rack: header strip plus a fixed grid of device cells.
export const EXPANDED_COLS = 2;
export const EXPANDED_HEADER = 48;
export const EXPANDED_PAD = 12;
export const EXPANDED_CELL_W = DEVICE_NODE_SIZE.width + 16;
export const EXPANDED_CELL_H = DEVICE_NODE_SIZE.height + 16;

export function expandedRackSize(deviceCount: number): { width: number; height: number } {
  const rows = Math.max(1, Math.ceil(Math.max(1, deviceCount) / EXPANDED_COLS));
  return {
    width: EXPANDED_PAD * 2 + EXPANDED_COLS * EXPANDED_CELL_W,
    height: EXPANDED_HEADER + EXPANDED_PAD + rows * EXPANDED_CELL_H + EXPANDED_PAD,
  };
}

// Position of a member device inside an expanded rack group, relative to the
// group's top-left corner. Also used to derive absolute device positions when
// a collapsed rack is dragged.
export function gridSlotPosition(index: number): { x: number; y: number } {
  const col = index % EXPANDED_COLS;
  const row = Math.floor(index / EXPANDED_COLS);
  return {
    x: EXPANDED_PAD + col * EXPANDED_CELL_W,
    y: EXPANDED_HEADER + EXPANDED_PAD + row * EXPANDED_CELL_H,
  };
}

export interface LayoutInputNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutInputEdge {
  source: string;
  target: string;
}

export type LayoutResult = Map<string, { x: number; y: number }>;

// Run dagre and return top-left positions keyed by node id.
export function dagreLayout(nodes: LayoutInputNode[], edges: LayoutInputEdge[]): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 140, marginx: 20, marginy: 20 });

  nodes.forEach(n => g.setNode(n.id, { width: n.width, height: n.height }));
  const ids = new Set(nodes.map(n => n.id));
  edges.forEach(e => {
    if (ids.has(e.source) && ids.has(e.target) && e.source !== e.target) {
      g.setEdge(e.source, e.target);
    }
  });

  dagre.layout(g);

  const result: LayoutResult = new Map();
  nodes.forEach(n => {
    const pos = g.node(n.id);
    if (pos) {
      result.set(n.id, { x: pos.x - n.width / 2, y: pos.y - n.height / 2 });
    }
  });
  return result;
}

// Position heuristic: devices/racks created before map positions existed carry
// the backend default (100, 100). Treat "both ~100" (and null-ish values) as
// unpositioned so dagre places them instead of stacking them in one corner.
export function isUnpositioned(x: number | null | undefined, y: number | null | undefined): boolean {
  if (x == null || y == null) return true;
  return Math.abs(x - 100) <= 1 && Math.abs(y - 100) <= 1;
}

// Shift a layout result so its bounding box starts next to the occupied area
// instead of overlapping already-positioned nodes.
export function offsetLayout(
  layout: LayoutResult,
  nodes: LayoutInputNode[],
  anchor: { x: number; y: number },
): LayoutResult {
  if (layout.size === 0) return layout;
  let minX = Infinity;
  let minY = Infinity;
  nodes.forEach(n => {
    const p = layout.get(n.id);
    if (!p) return;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  });
  if (!isFinite(minX) || !isFinite(minY)) return layout;
  const dx = anchor.x - minX;
  const dy = anchor.y - minY;
  const out: LayoutResult = new Map();
  layout.forEach((p, id) => out.set(id, { x: p.x + dx, y: p.y + dy }));
  return out;
}
