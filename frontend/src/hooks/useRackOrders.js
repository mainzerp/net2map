import { useState } from "react";

export function useRackOrders(selectedRack) {
  const [rackOrders, setRackOrders] = useState(() => {
    try { return JSON.parse(localStorage.getItem("netmap_rack_orders") || "{}"); }
    catch { return {}; }
  });

  const reorderDevice = (deviceId, direction, groupKey) => {
    if (!selectedRack) return;
    const rackDevices = Array.isArray(selectedRack.devices) ? selectedRack.devices : [];
    const rackId = selectedRack.id;
    const devs = rackDevices.filter(d =>
      groupKey === "tor"    ? (d.class_id === 1 || (!d.class_id && d.vendor === "fs")) :
      groupKey === "access" ? (d.class_id === 2 || (!d.class_id && d.vendor === "aruba_cx")) :
      d.class_id == null && d.vendor !== "fs" && d.vendor !== "aruba_cx"
    );
    const ids = devs.map(d => String(d.id));
    const targetId = String(deviceId);
    const storeKey = `${rackId}::${groupKey}`;
    const order = ((rackOrders[storeKey]) || []).map(id => String(id));
    const sorted = [...ids].sort((a, b) => {
      const ai = order.indexOf(a), bi = order.indexOf(b);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    const idx = sorted.indexOf(targetId);
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= sorted.length) return;
    [sorted[idx], sorted[newIdx]] = [sorted[newIdx], sorted[idx]];
    const newOrders = { ...rackOrders, [storeKey]: sorted };
    setRackOrders(newOrders);
    localStorage.setItem("netmap_rack_orders", JSON.stringify(newOrders));
  };

  return { rackOrders, reorderDevice };
}
