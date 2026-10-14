import type { QueryKey } from "@tanstack/react-query";

// Central query keys for the API data layer. Use these everywhere instead of
// inline key arrays so invalidation stays consistent.
export const queryKeys = {
  topology: ["topology"] as QueryKey,
  stats: ["stats"] as QueryKey,
  devices: ["devices"] as QueryKey,
  endpoints: ["endpoints"] as QueryKey,
  racks: ["racks"] as QueryKey,
  // Prefix ["rack-items"] matches the item lists of every rack.
  rackItems: (rackId?: number) => (rackId == null ? ["rack-items"] : ["rack-items", rackId]) as QueryKey,
  logs: (params?: Record<string, unknown>) => ["logs", params ?? {}] as QueryKey,
  snmpProfiles: ["snmp-profiles"] as QueryKey,
  credentials: ["credentials"] as QueryKey,
  // Prefix ["ping-candidates"] matches both the default and include_dismissed lists.
  pingCandidates: (includeDismissed?: boolean) =>
    (includeDismissed == null ? ["ping-candidates"] : ["ping-candidates", includeDismissed]) as QueryKey,
  switchModels: ["switch-models"] as QueryKey,
  switchClasses: ["switch-classes"] as QueryKey,
  scanSettings: ["scan-settings"] as QueryKey,
  appSettings: ["app-settings"] as QueryKey,
  scanRuns: ["scan-runs"] as QueryKey,
  scanJob: (jobId: string | null) => ["scan-job", jobId] as QueryKey,
  discoveryRanges: ["discovery-ranges"] as QueryKey,
  dnsSettings: ["dns-settings"] as QueryKey,
  buildings: ["buildings"] as QueryKey,
  latencySummary: ["latency", "summary"] as QueryKey,
  // Prefix ["latency", "history"] matches every range/device variant.
  latencyHistory: (params?: { range: string; deviceId?: number | null }) =>
    (params ? ["latency", "history", params.range, params.deviceId ?? null] : ["latency", "history"]) as QueryKey,
};
