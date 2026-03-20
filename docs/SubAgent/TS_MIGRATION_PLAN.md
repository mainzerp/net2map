# TypeScript Migration Plan

Based on: [TS_MIGRATION_ANALYSIS.md](TS_MIGRATION_ANALYSIS.md)

---

## Master Checklist

- [ ] **Wave 1: Cleanup dead files + styles**
  - [ ] Delete 12 dead .jsx/.js files that have .ts/.tsx replacements
  - [ ] Migrate `styles/tokens.js` -> `tokens.ts`
  - [ ] Migrate `styles/shared.js` -> `shared.ts`
  - [ ] Run `tsc --noEmit` to verify no regressions
- [ ] **Wave 2: Leaf components**
  - [ ] `ErrorBoundary.jsx` -> `.tsx`
  - [ ] `PortDetailModal.jsx` -> `.tsx`
  - [ ] `map/FilterBar.jsx` -> `.tsx`
  - [ ] `map/ActiveLinkBar.jsx` -> `.tsx`
  - [ ] Run `tsc --noEmit` to verify
- [ ] **Wave 3: Settings tab components**
  - [ ] `settings/DnsTab.jsx` -> `.tsx`
  - [ ] `settings/ImportExportTab.jsx` -> `.tsx`
  - [ ] `settings/MapSettingsTab.jsx` -> `.tsx`
  - [ ] `settings/RacksTab.jsx` -> `.tsx`
  - [ ] `settings/SwitchClassesTab.jsx` -> `.tsx`
  - [ ] `settings/SnmpProfilesTab.jsx` -> `.tsx`
  - [ ] `settings/SwitchModelsTab.jsx` -> `.tsx`
  - [ ] `settings/ScanSettingsTab.jsx` -> `.tsx`
  - [ ] `settings/CredentialsTab.jsx` -> `.tsx` (not in user wave but required -- last remaining .jsx in settings/)
  - [ ] Update `SettingsPage.tsx` imports (drop `.jsx` extensions)
  - [ ] Run `tsc --noEmit` to verify
- [ ] **Wave 4: Core components**
  - [ ] `Port.jsx` -> `.tsx`
  - [ ] `SwitchPanel.jsx` -> `.tsx`
  - [ ] `SwitchDetailSlideIn.jsx` -> `.tsx`
  - [ ] `map/RackDetail.jsx` -> `.tsx`
  - [ ] `DeviceTable.jsx` -> `.tsx`
  - [ ] Update `MapPage.tsx`, `DevicesPage.tsx`, `NetworkPage.tsx` imports
  - [ ] Run `tsc --noEmit` to verify
- [ ] **Wave 5: Complex + shell**
  - [ ] `map/TopologyMap.jsx` -> `.tsx`
  - [ ] `App.jsx` -> `App.tsx`
  - [ ] `main.jsx` -> `main.tsx`
  - [ ] Update `index.html` script src to `/src/main.tsx`
  - [ ] Update `main.tsx` import of `App` and `ErrorBoundary` (drop `.jsx`)
  - [ ] Run `tsc --noEmit` to verify
- [ ] **Wave 6: Final verification**
  - [ ] Audit all import paths -- no `.jsx` extensions remain
  - [ ] Run `npx tsc --noEmit` -- zero errors
  - [ ] Run `npx vitest run` -- all tests pass
  - [ ] Verify no `.jsx` or `.js` files remain in `src/` except test files and config

---

## Pre-flight: Types to Add to `types.ts`

Before any wave, add these types to `src/types.ts` so all waves can reference them.

```ts
// ── Filter state (used by FilterBar, TopologyMap, MapPage) ──────────────
export interface FilterState {
  racks: Set<number> | null;
  classes: Set<number> | null;
}

// ── Zoom state (used by TopologyMap) ────────────────────────────────────
export interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

// ── Port link map entry (returned by buildPortLinkMap in api.ts) ────────
export interface PortLinkEntry {
  link: TopologyLink;
  role: "local" | "remote";
}

// ── Endpoint detail (parsed from endpoint_details_json) ─────────────────
export interface EndpointDetail {
  mac?: string;
  ip?: string;
  host?: string;
  vlan?: number | null;
  [key: string]: unknown;
}

// ── Credential (CredentialsTab CRUD) ────────────────────────────────────
export interface Credential {
  id: number;
  label: string;
  ip: string;
  priority: number;
  snmp_port: number;
  location: string;
  enabled: boolean;
  profile_id: number | null;
  rack_id: number | null;
  class_id: number | null;
  vendor: string;
  model: string;
  snmp_version: string;
  community: string;
  v3_security_level: string;
  v3_username: string;
  v3_auth_protocol: string;
  v3_auth_password: string;
  v3_priv_protocol: string;
  v3_priv_password: string;
}

// ── SNMP Profile (SnmpProfilesTab, SettingsPage) ────────────────────────
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

// ── Scan run history (ScanSettingsTab) ───────────────────────────────────
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

// ── Discovery range (ScanSettingsTab) ───────────────────────────────────
export interface DiscoveryRange {
  id: number;
  range: string;
  [key: string]: unknown;
}

// ── DeviceTableProps (already declared but confirm completeness) ─────────
export interface DeviceTableProps {
  role: string;
  title: string;
  subtitle: string;
  activeLabel: string;
  ignoredLabel: string;
  emptyMessage: string;
}
```

**Note**: `FilterState` uses `Set<number>` in the actual code today. `MapPage.tsx` currently types `filters` as `{ racks: number[] | null; classes: number[] | null }` -- this should be updated to `FilterState` with `Set` to match the actual runtime usage. Alternatively, if the current page already works with arrays, keep it consistent. Check at implementation time which form is correct.

---

## Wave 1: Cleanup Dead Files + Styles

### Step 1.1 -- Delete 12 dead files

These files have `.ts`/`.tsx` replacements that are already active. The old files are dead code.

| # | File to DELETE | Replacement (keep) |
|---|---|---|
| 1 | `src/store.js` | `src/store.ts` |
| 2 | `src/hooks/useMapBackground.js` | `src/hooks/useMapBackground.ts` |
| 3 | `src/hooks/useTopologyData.js` | `src/hooks/useTopologyData.ts` |
| 4 | `src/hooks/useRackOrders.js` | `src/hooks/useRackOrders.ts` |
| 5 | `src/hooks/useScanProgress.js` | `src/hooks/useScanProgress.ts` |
| 6 | `src/pages/DashboardPage.jsx` | `src/pages/DashboardPage.tsx` |
| 7 | `src/pages/DevicesPage.jsx` | `src/pages/DevicesPage.tsx` |
| 8 | `src/pages/LoginPage.jsx` | `src/pages/LoginPage.tsx` |
| 9 | `src/pages/LogsPage.jsx` | `src/pages/LogsPage.tsx` |
| 10 | `src/pages/MapPage.jsx` | `src/pages/MapPage.tsx` |
| 11 | `src/pages/NetworkPage.jsx` | `src/pages/NetworkPage.tsx` |
| 12 | `src/pages/SettingsPage.jsx` | `src/pages/SettingsPage.tsx` |

**Command**: `git rm` each file to track the deletion.

### Step 1.2 -- Migrate `styles/tokens.js` -> `styles/tokens.ts`

**Current state**: Pure constant exports (colors, spacing, radii, fonts). No JSX.

**Changes needed**:
1. Rename file: `tokens.js` -> `tokens.ts`
2. Add `as const` satisfies to all exported objects for literal type inference:
   ```ts
   export const colors = { ... } as const;
   export const radii = { ... } as const;
   export const spacing = { ... } as const;
   export const fonts = { ... } as const;
   ```
3. No other changes needed -- all values are plain literals.

**Import changes**: `shared.js` imports from `./tokens.js` -- update after shared is also renamed.

### Step 1.3 -- Migrate `styles/shared.js` -> `styles/shared.ts`

**Current state**: Imports from `tokens.js`, exports `CSSProperties`-shaped style objects.

**Changes needed**:
1. Rename file: `shared.js` -> `shared.ts`
2. Update import path: `from "./tokens.js"` -> `from "./tokens"` (drop extension)
3. Type each exported style object as `React.CSSProperties`:
   ```ts
   import type React from "react";
   
   export const cardStyle: React.CSSProperties = { ... };
   export const inputStyle: React.CSSProperties = { ... };
   export const selectStyle: React.CSSProperties = { ... };
   export const labelStyle: React.CSSProperties = { ... };
   export const buttonBase: React.CSSProperties = { ... };
   export const primaryButton: React.CSSProperties = { ... };
   export const dangerButton: React.CSSProperties = { ... };
   export const secondaryButton: React.CSSProperties = { ... };
   export const tableHeaderStyle: React.CSSProperties = { ... };
   ```
4. The `textAlign: "left"` in `tableHeaderStyle` needs no special handling -- `React.CSSProperties` accepts it.

**Import changes**: Several components import from `../../styles/shared.js` or `../../styles/tokens.js` -- all import paths will be updated to drop `.js` extensions in the final pass (Wave 6).

### Step 1.4 -- Verify

```bash
cd frontend && npx tsc --noEmit
```

---

## Wave 2: Leaf Components

These components have no imports from other `.jsx` files. They only import from `api.ts`, `store.ts`, or React.

### Step 2.1 -- `components/ErrorBoundary.jsx` -> `.tsx`

**Key typing**:
- Class component needs generics: `Component<ErrorBoundaryProps, ErrorBoundaryState>`
- Define props/state interfaces:
  ```ts
  interface ErrorBoundaryProps {
    children: React.ReactNode;
  }
  interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
  }
  ```
- `getDerivedStateFromError(error: Error)` -- returns `Partial<ErrorBoundaryState>`
- `componentDidCatch(error: Error, info: React.ErrorInfo)` -- void
- Constructor: `constructor(props: ErrorBoundaryProps)`
- `this.state.error?.message` already works with optional chaining

**Import changes**: None (only imports `Component` from React).

### Step 2.2 -- `components/PortDetailModal.jsx` -> `.tsx`

**Key typing**:
- Props interface:
  ```ts
  interface PortDetailModalProps {
    port: PortInfo & { endpoint_details_json?: string | EndpointDetail[] };
    onClose: () => void;
  }
  ```
- `parsedEndpoints` computed via `useMemo` returns `EndpointDetail[]`
- `filtered` also returns `EndpointDetail[]`
- `filter` state: `useState<string>("")`
- Event handlers: `onChange: React.ChangeEvent<HTMLInputElement>` for the filter input
- Imports `speedLabel`, `speedColor` from `../api` (already typed)
- Port fields like `port.speed_mbps`, `port.endpoint_count` -- validate against `PortInfo` type; may need to extend `PortInfo` with `speed_mbps` and `endpoint_count` if missing

**Import changes**: Drop `.jsx` from any import paths.

### Step 2.3 -- `components/map/FilterBar.jsx` -> `.tsx`

**Key typing**:
- Props interface:
  ```ts
  interface FilterBarProps {
    racks: RackInfo[];
    classes: SwitchClass[];
    filters: FilterState;
    onFilterChange: (update: FilterState | ((prev: FilterState) => FilterState)) => void;
  }
  ```
- `toggleRack(rackId: number)` / `toggleClass(classId: number)` -- `Set<number>` manipulation
- `btnStyle(active: boolean): React.CSSProperties` -- style factory function
- Named export (not default): `export { FilterBar }`

**Import changes**: None (no imports from other JSX files).

### Step 2.4 -- `components/map/ActiveLinkBar.jsx` -> `.tsx`

**Key typing**:
- Props interface:
  ```ts
  interface ActiveLinkBarProps {
    link: TopologyLink;
    color: string;
    onClear: () => void;
  }
  ```
- Pure presentational, no state, no refs, no event handlers beyond `onClick`
- Named export: `export { ActiveLinkBar }`

**Import changes**: None.

### Step 2.5 -- Verify

```bash
cd frontend && npx tsc --noEmit
```

---

## Wave 3: Settings Tab Components

All settings tabs follow a similar CRUD pattern: form state, API calls, list rendering. None import other `.jsx` files -- they only import from `../../api` (already `.ts`).

### Common patterns across all settings tabs:
- `useState` needs explicit generic when initializer is an empty array: `useState<Type[]>([])`
- Event handlers: `React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>`
- Form state: type the form shape, e.g., `useState<RackForm>({ ...EMPTY_RACK_FORM })`
- API responses: type via function generics or cast at call sites
- `extractErrorMessage(ex: unknown)` -- already typed in `api.ts`

### Step 3.1 -- `settings/DnsTab.jsx` -> `.tsx`

**Props**: None (no props passed from SettingsPage).

**Key typing**:
- State: `serversText: string`, `loading: boolean`, `saving: boolean`, `err: string`, `ok: string`
- `save()` is async -- no explicit return type needed
- `onChange` on textarea: `React.ChangeEvent<HTMLTextAreaElement>`

**Interface**: None needed (no props).

### Step 3.2 -- `settings/ImportExportTab.jsx` -> `.tsx`

**Props interface**:
```ts
interface ImportExportTabProps {
  onProfilesChanged?: () => void;
}
```

**Key typing**:
- State: `configDryRun: boolean`, `configData: string`, `configBusy: boolean`, `configMsg: string`
- API return types: `res?.data` from export config endpoint
- Checkbox `onChange`: `React.ChangeEvent<HTMLInputElement>`

### Step 3.3 -- `settings/MapSettingsTab.jsx` -> `.tsx`

**Props interface**:
```ts
interface MapSettingsTabProps {
  url: string | null;
  opacity: number;
  scale: number;
  bgColor: string;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
  onChangeOpacity: (val: number) => void;
  onChangeScale: (val: number) => void;
  onChangeBgColor: (color: string) => void;
  loading: boolean;
  error: string;
}
```

**Key typing**:
- No internal state -- pure controlled component
- Range input `onChange`: `React.ChangeEvent<HTMLInputElement>` -> `parseFloat(e.target.value)`
- Color input `onChange`: `React.ChangeEvent<HTMLInputElement>`

### Step 3.4 -- `settings/RacksTab.jsx` -> `.tsx`

**Props interface**:
```ts
interface RacksTabProps {
  newEntryTrigger: number;
}
```

**Key typing**:
- Form type:
  ```ts
  interface RackForm {
    label: string;
    room: string;
    description: string;
  }
  const EMPTY_RACK_FORM: RackForm = { label: "", room: "", description: "" };
  ```
- State arrays: `useState<RackInfo[]>([])`, `useState<TopologyNode[]>([])`
- `editState: { id: number | null; open: boolean }`
- `assignSel: Record<number, string>` (rack ID -> selected device ID)
- `confirmDeleteId: number | null`
- API calls: `api.get<RackInfo[]>("/api/racks")` etc.

### Step 3.5 -- `settings/SwitchClassesTab.jsx` -> `.tsx`

**Props interface**:
```ts
interface SwitchClassesTabProps {
  newEntryTrigger: number;
}
```

**Key typing**:
- Same CRUD pattern as RacksTab
- Form type:
  ```ts
  interface ClassForm {
    label: string;
    description: string;
    color: string;
    allow_outside_rack: boolean;
  }
  ```
- Color picker: `React.ChangeEvent<HTMLInputElement>`
- `assignSel: Record<number, string>`

### Step 3.6 -- `settings/SnmpProfilesTab.jsx` -> `.tsx`

**Props interface**:
```ts
interface SnmpProfilesTabProps {
  profiles: SnmpProfile[];
  loading: boolean;
  onChanged: () => void;
  newEntryTrigger: number;
  loadError: string;
}
```

**Key typing**:
- Form type matches `EMPTY_PROFILE_FORM` shape:
  ```ts
  interface ProfileForm {
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
  ```
- Conditional v2c/v3 field rendering -- pure JSX logic, no extra typing needed
- `editState: { id: number | null; open: boolean }`

### Step 3.7 -- `settings/SwitchModelsTab.jsx` -> `.tsx`

**Props interface**:
```ts
interface SwitchModelsTabProps {
  newEntryTrigger: number;
}
```

**Key typing**:
- Form type:
  ```ts
  interface ModelForm {
    name: string;
    ports_per_row: number;
    total_ports: string | number;
    description: string;
  }
  ```
- `cutoffEnabled: boolean` toggle
- `assignSel: Record<number, string>`
- Same CRUD pattern

### Step 3.8 -- `settings/ScanSettingsTab.jsx` -> `.tsx`

**Props**: None (no props from SettingsPage).

**Key typing** (most complex settings tab, 668 lines):
- Many state variables need explicit types:
  ```ts
  scanning: boolean
  scanResult: ScanRun | null
  history: ScanRun[]
  scanWorkers: number
  snmpTimeout: number
  snmpRetries: number
  discoveryIntervalSec: number
  linkUpdateIntervalSec: number
  macUpdateIntervalSec: number
  activeJobId: string | null
  discoveryRanges: DiscoveryRange[]
  dryRunResult: Record<string, unknown> | null
  ```
- Timer ref: `useRef<ReturnType<typeof setInterval> | null>(null)`
- Polling logic: `setInterval` / `clearInterval` -- ref typed as above
- SVG progress bar: inline SVG elements, no special typing needed
- Input handlers: `React.ChangeEvent<HTMLInputElement>` for numeric inputs
- API responses: cast or use generic at call sites

### Step 3.9 -- `settings/CredentialsTab.jsx` -> `.tsx`

NOTE: Not in the user's original wave list but is the only remaining `.jsx` in `settings/`. Must be migrated here to avoid broken import from `SettingsPage.tsx`.

**Props interface**:
```ts
interface CredentialsTabProps {
  profiles: SnmpProfile[];
  newEntryTrigger: number;
}
```

**Key typing**:
- Form type matches `EMPTY_FORM`:
  ```ts
  interface CredentialForm {
    label: string;
    ip: string;
    priority: number;
    snmp_port: number;
    location: string;
    enabled: boolean;
    profile_id: number | null;
    rack_id: number | null;
    class_id: number | null;
    vendor: string;
    model: string;
    snmp_version: string;
    community: string;
    v3_security_level: string;
    v3_username: string;
    v3_auth_protocol: string;
    v3_auth_password: string;
    v3_priv_protocol: string;
    v3_priv_password: string;
  }
  ```
- Multiple arrays: `creds: Credential[]`, `devices: TopologyNode[]`, `racks: RackInfo[]`, `classes: SwitchClass[]`, `models: SwitchModel[]`
- `toggleIgnored` function: `(dev: TopologyNode) => Promise<void>`
- `togglingIgnoreId: number | null`

### Step 3.10 -- Update `SettingsPage.tsx` imports

Change all 9 imports from `.jsx` to no extension:
```ts
// Before
import SnmpProfilesTabContent from "../components/settings/SnmpProfilesTab.jsx";
// After
import SnmpProfilesTabContent from "../components/settings/SnmpProfilesTab";
```

Also remove the local `SnmpProfile` interface from `SettingsPage.tsx` and import it from `types.ts` instead.

### Step 3.11 -- Verify

```bash
cd frontend && npx tsc --noEmit
```

---

## Wave 4: Core Components

These components have import dependencies on other `.jsx` files that will have been migrated in earlier waves.

### Step 4.1 -- `components/Port.jsx` -> `.tsx`

**Props interface**:
```ts
interface PortProps {
  port: PortInfo & {
    speed_mbps?: number;
    endpoint_count?: number;
    endpoint_details_json?: string | EndpointDetail[];
    if_index?: number;
    if_descr?: string;
  };
  portKey: string;
  portLinkMap: Record<string, PortLinkEntry>;
  selectedLink: TopologyLink | null;
  onPortClick: (portKey: string) => void;
  cableColor: string | null;
  interRack: boolean;
  highlighted: boolean;
}
```

**Key typing**:
- `ref: useRef<HTMLDivElement>(null)` for tooltip positioning
- `pos` state: `useState<{ top: number; left: number }>({ top: 0, left: 0 })`
- `showModal` state: `useState<boolean>(false)`
- Dynamic style injection: `document.createElement("style")` -- typed as `HTMLStyleElement`
- `getBoundingClientRect()` returns `DOMRect` -- no explicit typing needed
- `scrollIntoView` on `ref.current` -- already typed via `HTMLDivElement`
- Tooltip position calculation with mouse event: `React.MouseEvent<HTMLDivElement>`
- Imports `PortDetailModal` -- update import to drop `.jsx` extension

**Import changes**: `import PortDetailModal from "./PortDetailModal"` (drop `.jsx`)

### Step 4.2 -- `components/SwitchPanel.jsx` -> `.tsx`

**Props interface**:
```ts
interface SwitchPanelProps {
  device: TopologyNode;
  otherRacks?: RackInfo[];
  onMove?: (deviceId: number, rackId: number) => void;
  onUpdateMeta?: (deviceId: number, meta: Record<string, unknown>) => void;
  portLinkMap: Record<string, PortLinkEntry>;
  selectedLink: TopologyLink | null;
  onPortClick: (portKey: string) => void;
  linkColorMap: Record<string, string>;
  switchClass?: SwitchClass;
  switchModel?: SwitchModel;
  interRackPortKeys?: Set<string>;
  onShowDetail?: (deviceId: number) => void;
  highlightPortKey: string | null;
}
```

**Key typing**:
- `panelRef: useRef<HTMLDivElement>(null)`
- `showMove` state: `useState<boolean>(false)`
- Renders `Port` components in a loop -- already migrated in 4.1
- `activePorts` derived from `device.ports.filter(...)` -- typed via `PortInfo[]`
- `pingStatus` derived from `device.ping_status` -- may need to extend `TopologyNode` with `ping_status?: string` and `ping_rtt_ms?: number` if not present

**Import changes**: `import Port from "./Port"` (drop `.jsx`)

### Step 4.3 -- `components/SwitchDetailSlideIn.jsx` -> `.tsx`

**Props interface**:
```ts
interface SwitchDetailSlideInProps {
  deviceId: number;
  nodes: TopologyNode[];
  topologyLinks: TopologyLink[];
  rackPairColorMap: Record<string, string>;
  allRacks: Array<RackInfo & { devices?: TopologyNode[] }>;
  onClose: () => void;
}
```

**Key typing**:
- `sortCol` state: `useState<string>("if_index")`
- `sortAsc` state: `useState<boolean>(true)`
- `device` via `useMemo` returns `TopologyNode | undefined`
- `deviceLinks` via `useMemo` returns `TopologyLink[]`
- `portLinkMap` via `useMemo` returns `Record<string, PortLinkEntry>`
- `linkColorMap` via `useMemo` returns `Record<string, string>`
- `columns` array should use `as const` assertion
- Imports `buildPortLinkMap`, `normPort`, `CABLE_COLORS` from `../api` -- already typed

**Import changes**: None (no JSX imports).

### Step 4.4 -- `components/map/RackDetail.jsx` -> `.tsx`

**Props interface**:
```ts
interface RackDetailProps {
  rack: SelectedRack;
  allRacks: RackInfo[];
  switchClasses: SwitchClass[];
  switchModels: SwitchModel[];
  topologyLinks: TopologyLink[];
  deviceOrder: Record<string, string[]>;
  onReorder: (deviceId: number, direction: "up" | "down", groupKey: string, devices: TopologyNode[]) => void;
  onReorderClass: (sectionKey: string, direction: "up" | "down") => void;
  onClose: () => void;
  onRename?: (newName: string) => void;
  onMoveDevice?: (deviceId: number, rackId: number) => void;
  onUpdateDeviceMeta?: (deviceId: number, meta: Record<string, unknown>) => void;
  rackPairColorMap: Record<string, string>;
  selectedLink: TopologyLink | null;
  onLinkSelect?: (link: TopologyLink | null) => void;
  onShowDetail: (deviceId: number) => void;
  highlightPortKey: string | null;
}
```

**Key typing** (586 lines, most complex in wave):
- `localOrder` state: `useState<Record<string, string[]>>({})`
- `localSectionOrder` state: `useState<string[]>([])`
- SVG line overlay: `getBoundingClientRect()` returns `DOMRect` -- used for computing link line positions
- `classSections` computed structure (from `useMemo`): type the intermediate grouping objects
- `applyLocalReorder` callback: complex index manipulation -- type params `(deviceId: number, direction: "up" | "down", groupKey: string, devices: TopologyNode[])`
- Device reordering: `Array<string>` for ordered IDs
- Port link map: `Record<string, PortLinkEntry>`
- Cable color computation: iterates over links, builds `Record<string, string>`

**Import changes**: `import SwitchPanel from "../SwitchPanel"` (drop `.jsx`)

### Step 4.5 -- `components/DeviceTable.jsx` -> `.tsx`

**Props interface** (already defined in `types.ts` as `DeviceTableProps`):
```ts
interface DeviceTableProps {
  role: string;
  title: string;
  subtitle: string;
  activeLabel: string;
  ignoredLabel: string;
  emptyMessage: string;
}
```

**Key typing** (586 lines, many state variables):
- All `useState` calls need generics:
  ```ts
  devices: TopologyNode[]
  loading: boolean
  togglingId: number | null
  selected: Set<number>
  bulkLoading: boolean
  racks: RackInfo[]
  classes: SwitchClass[]
  models: SwitchModel[]
  editState: { id: number | null; open: boolean }
  form: { rack_id: number | null; class_id: number | null; model_id: number | null }
  err: string
  search: string
  sort: { column: string | null; direction: "asc" | "desc" | null }
  ```
- `useNavigate()` -- typed by react-router-dom
- `useNetmapStore(s => ...)` -- store selectors already typed
- `refresh` callback: `useCallback(() => {...}, [role])`
- `toggleIgnored` function: `(dev: TopologyNode) => Promise<void>`
- `invalidateAll` function: `() => void`
- Table columns: define a `Column` interface or use inline types
- Sort/search comparators: type params explicitly
- Role-conditional columns: just conditional array elements
- `normPort` from api -- already typed

**Import changes**: None (imports only from `../api` and `../store`, already `.ts`).

### Step 4.6 -- Update consumer imports

Update imports in already-migrated `.tsx` pages:

**`MapPage.tsx`**:
```ts
// Before
import FilterBar from "../components/map/FilterBar.jsx";
import TopologyMap from "../components/map/TopologyMap.jsx";
import RackDetail from "../components/map/RackDetail.jsx";
import SwitchDetailSlideIn from "../components/SwitchDetailSlideIn.jsx";
// After (drop .jsx)
import FilterBar from "../components/map/FilterBar";
import TopologyMap from "../components/map/TopologyMap";
import RackDetail from "../components/map/RackDetail";
import SwitchDetailSlideIn from "../components/SwitchDetailSlideIn";
```

NOTE: TopologyMap is migrated in Wave 5, but its import path can be updated here since Vite resolves `.tsx` with or without extension.

**`DevicesPage.tsx`**:
```ts
import DeviceTable from "../components/DeviceTable";  // drop .jsx
```

**`NetworkPage.tsx`**:
```ts
import DeviceTable from "../components/DeviceTable";  // drop .jsx
```

### Step 4.7 -- Verify

```bash
cd frontend && npx tsc --noEmit
```

---

## Wave 5: Complex + Shell

### Step 5.1 -- `components/map/TopologyMap.jsx` -> `.tsx`

**Props interface**:
```ts
interface TopologyMapProps {
  nodes: (TopologyNode & { map_x?: number; map_y?: number })[];
  links: TopologyLink[];
  managedRacks: RackInfo[];
  switchClasses: SwitchClass[];
  filters: FilterState;
  onSelectRack: (rack: SelectedRack) => void;
  onSelectOutside: (node: TopologyNode) => void;
  selectedRackId: number | null;
  selectedOutsideId: number | null;
  centerRackId: number | null;
  onPositionChange: (nodeId: number, x: number, y: number) => void;
  mapBgUrl: string | null;
  mapBgOpacity: number;
  mapBgScale: number;
  mapBgNat: { w: number; h: number } | null;
  mapBgColor: string;
  rackPairColorMap: Record<string, string>;
  selectedLink: TopologyLink | null;
}
```

**Key typing** (440 lines, SVG-heavy):
- `svgRef: useRef<SVGSVGElement>(null)` -- critical for `createSVGPoint`, `getScreenCTM`
- `zoom` state: `useState<ZoomState>` (use type from `types.ts`)
- `positions` state: `useState<Record<number, { x: number; y: number }>>({})`
- `drag` state: typed as union:
  ```ts
  type DragInfo = {
    nodeId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null;
  ```
- SVG coordinate helpers:
  ```ts
  function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number }
  ```
  Uses `svg.createSVGPoint()` and `svg.getScreenCTM()?.inverse()` -- return `SVGPoint`
- Mouse event handlers:
  ```ts
  onMouseDown: React.MouseEvent<SVGSVGElement>
  onMouseMove: React.MouseEvent<SVGSVGElement>
  onMouseUp: React.MouseEvent<SVGSVGElement>
  onWheel: React.WheelEvent<SVGSVGElement>
  ```
- `useMemo` for rack aggregation: type intermediate structures
- `localStorage` read/write: already handled with try/catch
- Background pan state: `bgPan: { startX: number; startY: number; origTx: number; origTy: number } | null`

**Import changes**: None (no JSX imports -- only React hooks).

### Step 5.2 -- `App.jsx` -> `App.tsx`

**Key typing**:
- `NAV` array: add `as const` or type:
  ```ts
  interface NavItem {
    to: string;
    label: string;
  }
  const NAV: NavItem[] = [ ... ];
  ```
- `useLocation()`, `useNavigate()` -- typed by react-router-dom
- `getStoredToken()`, `getStoredUser()`, `logout()` -- already typed in `api.ts`
- `user` -- `{ username: string; role: string } | null`
- `handleLogout()` -- no params, void return
- `isActive` -- boolean
- No props (App is a route element)

**Import changes**: 
- `import { getStoredToken, getStoredUser, logout } from "./api"` -- already `.ts`, keep as-is

### Step 5.3 -- `main.jsx` -> `main.tsx`

**Key typing**:
- `createRoot(document.getElementById("root")!)` -- add non-null assertion since `#root` always exists
- All imports are from already-migrated files
- No state, no hooks, just JSX tree

**Import changes**:
```ts
// Before
import App from "./App.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
// After
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
```

Page imports already use no extension (e.g., `"./pages/DashboardPage"`), so no change needed there.

### Step 5.4 -- Update `index.html`

```html
<!-- Before -->
<script type="module" src="/src/main.jsx"></script>
<!-- After -->
<script type="module" src="/src/main.tsx"></script>
```

Vite natively handles `.tsx` entry points. No vite.config.js change needed.

### Step 5.5 -- Verify

```bash
cd frontend && npx tsc --noEmit
```

---

## Wave 6: Final Verification

### Step 6.1 -- Audit all import paths

Search entire `src/` for any remaining `.jsx` or `.js` import extensions:

```bash
grep -rn "\.jsx\|\.js'" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v __tests__
```

Update any found to drop the extension. Vite resolves `.ts`/`.tsx` files without needing explicit extensions.

### Step 6.2 -- Full TypeScript check

```bash
npx tsc --noEmit
```

Expected: **zero errors**. If errors appear, fix them before proceeding.

### Step 6.3 -- Run test suite

```bash
npx vitest run
```

All existing tests should pass. Test files in `__tests__/` can remain as `.js`/`.jsx` -- they are not production code and can be migrated separately.

### Step 6.4 -- Verify no production .jsx/.js remains

```bash
Get-ChildItem -Path src -Recurse -Include "*.jsx","*.js" | Where-Object { $_.FullName -notmatch '__tests__' -and $_.FullName -notmatch 'node_modules' }
```

Expected: **zero results** (except test files and possibly `vite.config.js` which is outside `src/`).

### Step 6.5 -- Extend `PortInfo` type if needed

During implementation, check whether `PortInfo` in `types.ts` needs these additional fields used by components:
- `speed_mbps: number` (used by Port.jsx)
- `endpoint_count: number` (used by Port.jsx)
- `endpoint_details_json: string | EndpointDetail[]` (used by Port.jsx, PortDetailModal.jsx)
- `if_index: number` (used by SwitchDetailSlideIn.jsx)
- `if_descr: string` (used by SwitchDetailSlideIn.jsx)
- `tagged_vlans: number[]` (already present)
- `poe_mw: number` (may be used by Port.jsx)

And whether `TopologyNode` needs:
- `ping_status: string` (used by SwitchPanel.jsx)
- `ping_rtt_ms: number` (used by SwitchPanel.jsx)
- `map_x: number` (used by TopologyMap.jsx)
- `map_y: number` (used by TopologyMap.jsx)

Add any missing fields during implementation, not as a separate step.

---

## Summary Statistics

| Wave | Files | Action | Est. Lines |
|------|-------|--------|-----------|
| 1 | 14 | 12 delete + 2 migrate | 131 (migrate) |
| 2 | 4 | Migrate | 293 |
| 3 | 9 (+1 CredentialsTab) | Migrate | 2,523 |
| 4 | 5 | Migrate | 1,762 |
| 5 | 3 | Migrate | 585 |
| 6 | 0 | Verification only | 0 |
| **Total** | **35** | | **5,294** |

---

## Risk Mitigation

1. **Run `tsc --noEmit` after every wave** -- catches type errors early before they compound.
2. **Migrate leaf-first** -- ensures no component is migrated before its dependencies.
3. **Keep `.jsx` extension in imports until the file itself is migrated** -- prevents broken imports during partial migration.
4. **Add types to `types.ts` up front** -- avoids inline type duplication across files.
5. **Do not change any runtime logic** -- this is a pure type-annotation migration. No behavior changes.
