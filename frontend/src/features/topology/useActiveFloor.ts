// Active map floor: URL search param `floor` wins over the persisted store
// value (localStorage "net2map-floor"); the result is resolved against the
// current buildings so stale ids fall back to the first floor. Returns null
// while the topology is not loaded or when no floors exist (unscoped map).

import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import useNet2MapStore from "../../store";
import type { Building } from "../../types";
import { FLOOR_PARAM, formatFloorKey, parseFloorKey, resolveActiveFloor, type FloorKey } from "./floors";

export function useActiveFloor(
  buildings: Building[] | undefined,
  unassignedAvailable: boolean,
  loaded: boolean,
): { active: FloorKey | null; setActive: (key: FloorKey) => void } {
  const [searchParams, setSearchParams] = useSearchParams();
  const stored = useNet2MapStore(s => s.activeFloor);
  const setStored = useNet2MapStore(s => s.setActiveFloor);
  const urlKey = parseFloorKey(searchParams.get(FLOOR_PARAM));
  const requested = urlKey ?? stored;

  const active = useMemo(
    () => (loaded ? resolveActiveFloor(buildings, requested, unassignedAvailable) : null),
    [loaded, buildings, requested, unassignedAvailable],
  );

  // A floor given in the URL becomes the persisted choice as well.
  useEffect(() => {
    if (urlKey != null && urlKey !== stored) setStored(urlKey);
  }, [urlKey, stored, setStored]);

  const setActive = useCallback(
    (key: FloorKey) => {
      setStored(key);
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          next.set(FLOOR_PARAM, formatFloorKey(key));
          return next;
        },
        { replace: true },
      );
    },
    [setStored, setSearchParams],
  );

  return { active, setActive };
}
