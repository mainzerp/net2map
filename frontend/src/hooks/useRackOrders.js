import useNetmapStore from "../store.js";

export function useRackOrders() {
  const rackOrders = useNetmapStore(s => s.rackOrders);
  const setRackOrders = useNetmapStore(s => s.setRackOrders);

  const reorderDevice = (deviceId, direction, groupKey, rackId, rackDevicesInput) => {
    if (rackId == null) return;
    const rackDevices = Array.isArray(rackDevicesInput) ? rackDevicesInput : [];
    const parsedClassId = typeof groupKey === "string" && groupKey.startsWith("class:")
      ? Number(groupKey.slice(6))
      : null;
    const devs = rackDevices.filter(d => {
      if (parsedClassId != null && Number.isFinite(parsedClassId)) return d.class_id === parsedClassId;
      if (groupKey === "unclassified") return d.class_id == null;
      if (groupKey === "tor") return d.class_id === 1 || (!d.class_id && d.vendor === "fs");
      if (groupKey === "access") return d.class_id === 2 || (!d.class_id && d.vendor === "aruba_cx");
      if (groupKey === "other") return d.class_id == null && d.vendor !== "fs" && d.vendor !== "aruba_cx";
      return false;
    });
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
    setRackOrders(prev => ({ ...prev, [storeKey]: sorted }));
  };

  const reorderClassSection = (sectionKey, direction, rackId, currentSectionKeysInput) => {
    if (rackId == null) return;
    const currentSectionKeys = Array.isArray(currentSectionKeysInput)
      ? currentSectionKeysInput.map(k => String(k))
      : [];
    if (!currentSectionKeys.length) return;

    const storeKey = `${rackId}::__class_sections__`;
    const saved = ((rackOrders[storeKey]) || []).map(k => String(k));
    const base = saved.length ? saved : currentSectionKeys;
    const merged = [
      ...base.filter(k => currentSectionKeys.includes(k)),
      ...currentSectionKeys.filter(k => !base.includes(k)),
    ];

    const idx = merged.indexOf(String(sectionKey));
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= merged.length) return;

    [merged[idx], merged[newIdx]] = [merged[newIdx], merged[idx]];
    setRackOrders(prev => ({ ...prev, [storeKey]: merged }));
  };

  return { rackOrders, reorderDevice, reorderClassSection };
}
