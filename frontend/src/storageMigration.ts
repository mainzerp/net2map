// One-time copy of browser preferences saved under the former NetMap keys.
// Imported first in main.tsx so it runs before any module reads storage.
export const LEGACY_STORAGE_KEYS: Record<string, string> = {
  "netmap-theme": "net2map-theme",
  "netmap-sidebar-collapsed": "net2map-sidebar-collapsed",
  "netmap_rack_orders": "net2map_rack_orders",
  "netmap-zoom": "net2map-zoom",
  "netmap-map-layer": "net2map-map-layer",
  "netmap-map-layer-vlan": "net2map-map-layer-vlan",
  "netmap-map-flow": "net2map-map-flow",
  "netmap-rack-activity": "net2map-rack-activity",
  "netmap.palette.recent": "net2map.palette.recent",
};

export function migrateLegacyStorageKeys(storage: Storage): void {
  for (const [legacy, current] of Object.entries(LEGACY_STORAGE_KEYS)) {
    const value = storage.getItem(legacy);
    if (value === null) continue;
    if (storage.getItem(current) === null) storage.setItem(current, value);
    storage.removeItem(legacy);
  }
}

try {
  migrateLegacyStorageKeys(window.localStorage);
} catch {
  // Storage unavailable (private mode, disabled cookies): nothing to migrate.
}
