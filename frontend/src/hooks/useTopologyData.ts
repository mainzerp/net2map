import { useEffect, useRef } from "react";
import useNetmapStore from "../store";

export function useTopologyData() {
  const topology = useNetmapStore(s => s.topology);
  const selectedRack = useNetmapStore(s => s.selectedRack);
  const setSelectedRack = useNetmapStore(s => s.setSelectedRack);
  const loadError = useNetmapStore(s => s.loadError);
  const loadTopology = useNetmapStore(s => s.loadTopology);
  const restoreSelectedRack = useNetmapStore(s => s.restoreSelectedRack);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    loadTopology().then(data => {
      if (data) restoreSelectedRack(data);
    });
  }, [loadTopology, restoreSelectedRack]);

  return { topology, selectedRack, setSelectedRack, loadError, loadTopology };
}
