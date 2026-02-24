import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../api.js";

export function useTopologyData() {
  const [topology, setTopology] = useState({ nodes: [], links: [], racks: [], classes: [] });
  const [selectedRack, setSelectedRack] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const initializedRef = useRef(false);

  const loadTopology = useCallback(() => {
    initializedRef.current = true;
    api.get("/api/topology").then(data => {
      setTopology(data);
    }).catch(e => setLoadError(e.message || "Failed to load topology"));
  }, []);

  // Initial load + sessionStorage selectedRack restore
  useEffect(() => {
    api.get("/api/topology").then(data => {
      setTopology(data);
      const savedId = sessionStorage.getItem("selectedRackId");
      if (savedId) {
        const id = Number(savedId);
        const rack = (data.racks || []).find(r => r.id === id);
        if (rack) {
          const devices = data.nodes.filter(n => n.rack_id === id);
          setSelectedRack({
            id: rack.id,
            label: rack.label,
            location: rack.location || `${rack.label}${rack.room ? " / " + rack.room : ""}`,
            devices,
          });
        } else {
          sessionStorage.removeItem("selectedRackId");
        }
      }
      initializedRef.current = true;
    }).catch(e => setLoadError(e.message || "Failed to load topology"));
  }, []);

  // Persist selectedRack to sessionStorage (skip before initial load completes)
  useEffect(() => {
    if (!initializedRef.current) return;
    if (selectedRack) sessionStorage.setItem("selectedRackId", String(selectedRack.id));
    else sessionStorage.removeItem("selectedRackId");
  }, [selectedRack]);

  return { topology, selectedRack, setSelectedRack, loadError, loadTopology };
}
