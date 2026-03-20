// ── API response types ───────────────────────────────────────────────────────

export interface FoundOnPort {
  mac: string;
  ip: string;
  hostname: string;
  vlan: number | null;
}

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
  found_on_port: FoundOnPort[];
  peer_ip?: string;
  peer_mac?: string;
  peer_host?: string;
  endpoint_details_json?: string | unknown[] | null;
  endpoint_count?: number;
  [key: string]: unknown;
}

export interface TopologyNode {
  id: number;
  ip: string;
  hostname: string;
  sys_name: string;
  vendor: string;
  model: string;
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
  location?: string;
  label?: string;
  enabled?: boolean;
  is_managed?: boolean;
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

export interface NetmapState {
  // Topology
  topology: TopologyData;
  selectedRack: SelectedRack | null;
  loadError: string | null;
  loadTopology: () => Promise<TopologyData | null>;
  setSelectedRack: (rack: SelectedRack | null | ((prev: SelectedRack | null) => SelectedRack | null)) => void;
  restoreSelectedRack: (data: TopologyData) => void;

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
  role: "network" | "endpoint";
  title: string;
  subtitle: string;
  activeLabel: string;
  ignoredLabel: string;
  emptyMessage: string;
}

// -- Filter state (used by FilterBar, TopologyMap, MapPage) -------------------
export interface FilterState {
  racks: Set<number> | null;
  classes: Set<number> | null;
}

// -- Zoom state (used by TopologyMap) -----------------------------------------
export interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

// -- Port link map entry (returned by buildPortLinkMap in api.ts) -------------
export interface PortLinkEntry {
  link: TopologyLink;
  role: "local" | "remote";
}

// -- Endpoint detail (parsed from endpoint_details_json) ----------------------
export interface EndpointDetail {
  mac?: string;
  ip?: string;
  host?: string;
  vlan?: number | null;
  [key: string]: unknown;
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
