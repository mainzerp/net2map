// URL-addressed inspector state. The shared inspector drawer (see
// features/inspector/InspectorDrawer.tsx) is driven by the `inspect` search
// param on any route: `device:<id>`, `endpoint:<id>` or `rack:<id>`.
// Opening pushes a history entry so the browser Back button closes the
// drawer; closing removes the param and keeps every other param intact.

import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

export const INSPECT_PARAM = "inspect";

export type InspectorKind = "device" | "endpoint" | "rack";

export interface InspectorTarget {
  kind: InspectorKind;
  id: number;
}

const KINDS: readonly InspectorKind[] = ["device", "endpoint", "rack"];

export function parseInspectParam(raw: string | null | undefined): InspectorTarget | null {
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep < 0) return null;
  const kind = raw.slice(0, sep) as InspectorKind;
  const idText = raw.slice(sep + 1);
  if (!KINDS.includes(kind) || !/^\d+$/.test(idText)) return null;
  return { kind, id: Number(idText) };
}

export function formatInspectParam(kind: InspectorKind, id: number | string): string {
  return `${kind}:${id}`;
}

/**
 * Build a `?search` string that keeps the current inspect param (if any) so
 * the drawer stays open when navigating to another route.
 */
export function searchWithInspect(params: Record<string, string>, inspectRaw: string | null): string {
  const next = new URLSearchParams(params);
  if (inspectRaw) next.set(INSPECT_PARAM, inspectRaw);
  const text = next.toString();
  return text ? `?${text}` : "";
}

export function useInspector() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(INSPECT_PARAM);
  const target = useMemo(() => parseInspectParam(raw), [raw]);

  const open = useCallback(
    (kind: InspectorKind, id: number | string) => {
      const value = formatInspectParam(kind, id);
      // Re-opening the current target must not stack duplicate history entries.
      if (value === raw) return;
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(INSPECT_PARAM, value);
        return next;
      });
    },
    [setSearchParams, raw],
  );

  const close = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(INSPECT_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  return { target, raw, open, close };
}
