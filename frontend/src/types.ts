// ── API response types ───────────────────────────────────────────────────────

export interface PortInfo {
  id?: number;
  port_id: string;
  name: string;
  if_index?: number;
  if_descr?: string;
  oper_status: number;
  speed: number;
  speed_mbps?: number;
  vlan: number | null;
  tagged_vlans: number[];
  poe_status: string | null;
  endpoint_count: number;
  stp_state?: StpPortState | null;
  stp_role?: StpPortRole | null;
  stp_path_cost?: number | null;
  [key: string]: unknown;
}

export type StpPortState = "disabled" | "blocking" | "listening" | "learning" | "forwarding" | "broken";
export type StpPortRole = "root" | "designated" | "blocked" | "disabled";

export interface DeviceStpInfo {
  protocol: "stp" | "rstp" | "mstp" | "unknown";
  bridge_id: string | null;
  root_id: string | null;
  root_cost: number | null;
  root_port: string | null;
  is_root: boolean;
}

export interface TopologyNode {
  id: number;
  ip: string;
  hostname: string;
  sys_name: string;
  vendor: string;
  model: string;
  firmware?: string;
  mac: string;
  rack_id: number | null;
  class_id: number | null;
  model_id: number | null;
  x: number | null;
  y: number | null;
  map_x: number;
  map_y: number;
  ignored: boolean;
  role: string;
  ports_per_row: number;
  total_ports: number;
  ports: PortInfo[];
  ping_status?: string;
  ping_rtt_ms?: number;
  // Per-device opt-in for the latency monitor (only honored in "selected" mode).
  latency_monitored?: boolean;
  location?: string;
  label?: string;
  enabled?: boolean;
  rack_u_position?: number | null;
  u_height?: number;
  stp?: DeviceStpInfo | null;
  // VLAN id (as string) -> VLAN name
  vlan_names?: Record<string, string>;
  [key: string]: unknown;
}

export interface TopologyLink {
  id: number;
  local_ip: string;
  local_port: string;
  remote_ip: string;
  remote_port: string;
  local_sys_name: string;
  remote_sys_name: string;
  speed_label?: string;
}

export interface RackInfo {
  id: number;
  label: string;
  location: string;
  room: string;
  description?: string;
  row_pos: number | null;
  col_pos: number | null;
  map_x?: number;
  map_y?: number;
  height_u?: number;
}

export interface SwitchClass {
  id: number;
  label: string;
  color: string;
  description?: string;
  allow_outside_rack: boolean;
}

export interface SwitchModel {
  id: number;
  name: string;
  ports_per_row: number;
  total_ports: number;
}

export interface TopologyData {
  nodes: TopologyNode[];
  links: TopologyLink[];
  racks: RackInfo[];
  classes: SwitchClass[];
  models: SwitchModel[];
}

// ── Latency monitor (GET /api/latency/summary, /api/latency/history) ────────

export type LatencyStatus = "ok" | "degraded" | "loss" | "down" | "unknown";
export type LatencyRange = "1h" | "24h" | "7d";
export type LatencyMode = "all" | "selected";

export interface LatencyDevice {
  device_id: number;
  name: string;
  ip: string;
  rtt_ms: number | null;
  jitter_ms: number | null;
  loss_pct: number | null;
  baseline_ms: number | null;
  status: LatencyStatus;
  updated_at: string | null;
}

export interface LatencyNetwork {
  median_ms: number | null;
  p95_ms: number | null;
  loss_pct: number | null;
  targets: number;
  reachable: number;
  degraded: number;
}

export interface LatencySummary {
  enabled: boolean;
  interval_sec: number;
  mode: LatencyMode;
  monitor_alive: boolean;
  updated_at: string | null;
  network: LatencyNetwork;
  // Pre-sorted by severity: down, loss, degraded, ok, unknown.
  devices: LatencyDevice[];
}

export interface LatencyPoint {
  ts: string;
  rtt_ms: number | null;
  jitter_ms: number | null;
  loss_pct: number | null;
}

export interface LatencyHistory {
  range: LatencyRange | string;
  device_id: number | null;
  bucket_sec: number;
  points: LatencyPoint[];
}

// ── Store types ──────────────────────────────────────────────────────────────

export interface SelectedRack {
  id: number;
  label: string;
  location: string;
  devices: TopologyNode[];
}

export interface ScanProgress {
  type: string;
  job_id?: string;
  current_ip?: string;
  latest_ip?: string;
  total?: number;
  completed?: number;
  scanned?: number;
  message?: string;
  [key: string]: unknown;
}

export interface Net2MapState {
  // Topology selection (topology data itself lives in TanStack Query)
  selectedRack: SelectedRack | null;
  setSelectedRack: (rack: SelectedRack | null | ((prev: SelectedRack | null) => SelectedRack | null)) => void;

  // Highlight
  highlightPortKey: string | null;
  setHighlightPortKey: (key: string | null) => void;
  clearHighlightPortKey: () => void;

  // Map background
  bgUrl: string | null;
  bgNat: { w: number; h: number } | null;
  bgOpacity: number;
  bgScale: number;
  bgColor: string;
  // Cache-bust token for /api/map-background URLs: stable per session so the
  // image stays cached, bumped on successful upload/delete mutations.
  bgVersion: number;
  bumpMapBackgroundVersion: () => void;
  loadMapBackground: () => void;
  loadMapSettings: () => void;

  // Scan
  activeScanJobId: string | null;
  scanStatus: string | null;
  startScan: () => Promise<{ job_id: string; status: string }>;
  setScanStatus: (status: string | null) => void;
  clearScanJob: () => void;

  // Rack orders
  rackOrders: Record<string, string[]>;
  setRackOrders: (ordersOrFn: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>)) => void;
}

// ── Component prop types (shared across pages) ──────────────────────────────

export interface DeviceTableProps {
  title: string;
  subtitle: string;
  activeLabel: string;
  ignoredLabel: string;
  emptyMessage: string;
}

// -- Filter state (used by MapPage and features/topology) ---------------------
export interface FilterState {
  racks: Set<number> | null;
  classes: Set<number> | null;
}

// -- Port link map entry (returned by buildPortLinkMap in api.ts) -------------
export interface PortLinkEntry {
  link: TopologyLink;
  role: "from" | "to";
}

// -- Endpoint (separate endpoint table) ----------------------------------------
export interface EndpointPortInfo {
  port_id: number;
  switch_ip: string;
  switch_name: string;
  port_name: string;
  vlan_id: number | null;
  last_seen: string | null;
}

export interface Endpoint {
  id: number;
  mac: string;
  ip: string | null;
  hostname: string | null;
  first_seen: string | null;
  last_seen: string | null;
  ignored: boolean;
  notes: string | null;
  found_on: EndpointPortInfo[];
}

// -- Credential (CredentialsTab CRUD) -----------------------------------------
export interface Credential {
  id: number;
  label: string;
  ip: string;
  priority: number;
  snmp_port: number;
  enabled: boolean;
  profile_id: number | null;
  device_id: number | null;
  snmp_version: string;
  community: string;
  v3_security_level: string;
  v3_username: string;
  v3_auth_protocol: string;
  v3_auth_password: string;
  v3_priv_protocol: string;
  v3_priv_password: string;
  /** Manual engine ID override (lowercase hex); null = automatic discovery. */
  v3_engine_id?: string | null;
  /** Read-only: engine ID observed during the last successful scan (hex). */
  discovered_engine_id?: string | null;
  /** Read-only: when discovered_engine_id was last observed (UTC). */
  engine_id_seen_at?: string | null;
}

// -- SNMP Profile (SnmpProfilesTab, SettingsPage) -----------------------------
export interface SnmpProfile {
  id: number;
  label: string;
  snmp_version: string;
  community: string;
  v3_security_level: string;
  v3_username: string;
  v3_auth_protocol: string;
  v3_auth_password: string;
  v3_priv_protocol: string;
  v3_priv_password: string;
}

// -- Scan run history (ScanSettingsTab) ----------------------------------------
export interface ScanRun {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  total: number;
  scanned: number;
  new_devices: number;
  [key: string]: unknown;
}

// -- Discovery range (ScanSettingsTab) ----------------------------------------
export interface DiscoveryRange {
  id: number;
  range: string;
  [key: string]: unknown;
}
