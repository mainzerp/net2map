// One-time copy of browser preferences saved under the former NetMap keys.
// Imported first in main.tsx so it runs before any module reads storage.
export const LEGACY_STORAGE_KEYS: Record<string, string> = {
  "netmap-theme": "net2map-theme",
  "netmap-sidebar-collapsed": "net2map-sidebar-collapsed",
  "netmap_rack_orders": "net2map_rack_orders",
  "netmap-zoom": "net2map-zoom",
  "netmap-floor": "net2map-floor",
  "netmap-map-layer": "net2map-map-layer",
  "netmap-map-layer-vlan": "net2map-map-layer-vlan",
  "netmap-map-flow": "net2map-map-flow",
  "netmap-rack-activity": "net2map-rack-activity",
  "netmap.palette.recent": "net2map.palette.recent",
};

// Prefixed keys carry a per-item suffix (e.g. the per-floor viewport
// "netmap-zoom:<floorKey>"); the suffix is kept as is.
export const LEGACY_STORAGE_PREFIXES: Record<string, string> = {
  "netmap-zoom:": "net2map-zoom:",
};

function migrateKey(storage: Storage, legacy: string, current: string): void {
  const value = storage.getItem(legacy);
  if (value === null) return;
  if (storage.getItem(current) === null) storage.setItem(current, value);
  storage.removeItem(legacy);
}

export function migrateLegacyStorageKeys(storage: Storage): void {
  for (const [legacy, current] of Object.entries(LEGACY_STORAGE_KEYS)) {
    migrateKey(storage, legacy, current);
  }
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  for (const key of keys) {
    for (const [legacyPrefix, currentPrefix] of Object.entries(LEGACY_STORAGE_PREFIXES)) {
      if (key.startsWith(legacyPrefix)) {
        migrateKey(storage, key, currentPrefix + key.slice(legacyPrefix.length));
      }
    }
  }
}

try {
  migrateLegacyStorageKeys(window.localStorage);
} catch {
  // Storage unavailable (private mode, disabled cookies): nothing to migrate.
}
