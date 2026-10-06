// Recently opened inspector targets, shown by the command palette when the
// query is empty. Stored as `kind:id` strings, most recent first.

import { formatInspectParam, parseInspectParam, type InspectorTarget } from "../../hooks/useInspector";

export const RECENT_STORAGE_KEY = "net2map.palette.recent";
export const RECENT_LIMIT = 5;

export function readRecent(): InspectorTarget[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => parseInspectParam(typeof entry === "string" ? entry : null))
      .filter((t): t is InspectorTarget => t !== null)
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function pushRecent(target: InspectorTarget): void {
  const key = formatInspectParam(target.kind, target.id);
  const rest = readRecent()
    .map((t) => formatInspectParam(t.kind, t.id))
    .filter((k) => k !== key);
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify([key, ...rest].slice(0, RECENT_LIMIT)));
  } catch {
    // Storage unavailable: the recent list just will not persist.
  }
}
