import type { QueryKey } from "@tanstack/react-query";

// Central query keys for the API data layer. Use these everywhere instead of
// inline key arrays so invalidation stays consistent.
export const queryKeys = {
  topology: ["topology"] as QueryKey,
  stats: ["stats"] as QueryKey,
  devices: ["devices"] as QueryKey,
  endpoints: ["endpoints"] as QueryKey,
  racks: ["racks"] as QueryKey,
  logs: (params?: Record<string, unknown>) => ["logs", params ?? {}] as QueryKey,
  snmpProfiles: ["snmp-profiles"] as QueryKey,
  credentials: ["credentials"] as QueryKey,
  switchModels: ["switch-models"] as QueryKey,
  switchClasses: ["switch-classes"] as QueryKey,
  scanSettings: ["scan-settings"] as QueryKey,
  appSettings: ["app-settings"] as QueryKey,
  scanRuns: ["scan-runs"] as QueryKey,
  discoveryRanges: ["discovery-ranges"] as QueryKey,
  dnsSettings: ["dns-settings"] as QueryKey,
  mapSettings: ["map-settings"] as QueryKey,
  mapBackground: ["map-background"] as QueryKey,
};
