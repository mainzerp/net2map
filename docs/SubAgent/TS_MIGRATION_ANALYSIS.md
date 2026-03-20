# TypeScript Migration Analysis

## Current State Summary

The frontend has a partial TypeScript migration. The following are **already migrated** to TypeScript:
- `api.ts` (174 lines)
- `store.ts` (113 lines)
- `types.ts` (131 lines)
- All 7 pages (`DashboardPage.tsx`, `DevicesPage.tsx`, `LoginPage.tsx`, `LogsPage.tsx`, `MapPage.tsx`, `NetworkPage.tsx`, `SettingsPage.tsx`)
- All 4 hooks (`useMapBackground.ts`, `useRackOrders.ts`, `useScanProgress.ts`, `useTopologyData.ts`)

**However**, the old `.jsx`/`.js` counterparts for the above files still exist and need deletion.

---

## Phase 1: Files to DELETE (already have .ts/.tsx replacements)

These files have both old and new versions. The `.tsx`/`.ts` version is the active one. The `.jsx`/`.js` file must be deleted.

| Old File (delete) | Replacement (keep) | Lines |
|---|---|---|
| `pages/DashboardPage.jsx` | `pages/DashboardPage.tsx` | 346 |
| `pages/DevicesPage.jsx` | `pages/DevicesPage.tsx` | 13 |
| `pages/LoginPage.jsx` | `pages/LoginPage.tsx` | 136 |
| `pages/LogsPage.jsx` | `pages/LogsPage.tsx` | 137 |
| `pages/MapPage.jsx` | `pages/MapPage.tsx` | 279 |
| `pages/NetworkPage.jsx` | `pages/NetworkPage.tsx` | 13 |
| `pages/SettingsPage.jsx` | `pages/SettingsPage.tsx` | 231 |
| `hooks/useMapBackground.js` | `hooks/useMapBackground.ts` | 19 |
| `hooks/useTopologyData.js` | `hooks/useTopologyData.ts` | 19 |
| `hooks/useRackOrders.js` | `hooks/useRackOrders.ts` | 55 |
| `hooks/useScanProgress.js` | `hooks/useScanProgress.ts` | 64 |
| `store.js` | `store.ts` | 111 |

**Total: 12 files to delete** (1,423 lines of dead code)

---

## Phase 2: Files Requiring MIGRATION (no .ts/.tsx version exists yet)

### 2A -- Styles (pure JS objects, no JSX)

| # | File | Lines | Complexity | Notes |
|---|---|---|---|---|
| 1 | `styles/tokens.js` | 61 | Simple | Pure constant exports (colors, spacing, etc.). Rename to `.ts`, add `as const` or explicit types. No JSX. |
| 2 | `styles/shared.js` | 70 | Simple | Imports from `tokens.js`, exports `CSSProperties` style objects. Rename to `.ts`, type as `React.CSSProperties`. |

### 2B -- Components

| # | File | Lines | Complexity | Key Typing Challenges | Imports from other JSX |
|---|---|---|---|---|---|
| 3 | `components/map/ActiveLinkBar.jsx` | 26 | Simple | 3 props (`link`, `color`, `onClear`). Pure presentational. Inline styles only. | None |
| 4 | `components/ErrorBoundary.jsx` | 39 | Simple | Class component. Needs `React.Component<Props, State>` generic. `getDerivedStateFromError` typing. `this.props.children` needs `React.ReactNode`. | None |
| 5 | `components/PortDetailModal.jsx` | 144 | Simple | Props: `port` object, `onClose`. `JSON.parse` for `endpoint_details_json`. Style objects. | None (imports from `api.ts`) |
| 6 | `components/map/FilterBar.jsx` | 84 | Simple | Props: arrays, `Set`-based filters, callback `onFilterChange`. Inline style factory function. | None |
| 7 | `components/settings/DnsTab.jsx` | 88 | Simple | Standard form state. API calls. Inline styles. | None (imports from `api.ts`) |
| 8 | `components/settings/ImportExportTab.jsx` | 64 | Simple | Props: `onProfilesChanged` callback. Simple form state. API calls. | None |
| 9 | `components/settings/MapSettingsTab.jsx` | 90 | Simple | Many props (url, opacity, scale, fileRef, callbacks). `useRef` for file input. | None |
| 10 | `components/settings/RacksTab.jsx` | 176 | Medium | CRUD pattern: form state, modal, list rendering. API calls for racks/devices. Select + assign pattern. | None |
| 11 | `components/settings/SwitchClassesTab.jsx` | 201 | Medium | Same CRUD pattern as RacksTab. Color picker. Assign/unassign devices. | None |
| 12 | `components/settings/SnmpProfilesTab.jsx` | 208 | Medium | CRUD + conditional SNMP v2c/v3 form fields. Props: `profiles`, `loading`, `onChanged`, `newEntryTrigger`, `loadError`. | None |
| 13 | `components/settings/SwitchModelsTab.jsx` | 232 | Medium | CRUD pattern. Toggle cutoff. Assign/unassign. | None |
| 14 | `components/settings/CredentialsTab.jsx` | 454 | Medium-Complex | Large CRUD form. Multiple selects (vendor, rack, class, profile, SNMP version). Conditional v3 fields. `toggleIgnored` on devices. | None |
| 15 | `components/settings/ScanSettingsTab.jsx` | 668 | Complex | Largest settings tab. Multiple form sections (scan workers, intervals, discovery ranges). Polling for scan jobs/dry runs. History table. Many `useRef`/`useEffect`. SVG progress bar. | None |
| 16 | `components/Port.jsx` | 188 | Medium | Props: port data, link map, colors, highlight state. Dynamic style injection (`document.createElement("style")`). Tooltip positioning with `getBoundingClientRect`. `scrollIntoView`. | Imports `PortDetailModal.jsx` |
| 17 | `components/SwitchPanel.jsx` | 161 | Medium | Props: device, racks, link map, callbacks. Renders Port components. `useRef` for panel element. | Imports `Port.jsx` |
| 18 | `components/SwitchDetailSlideIn.jsx` | 241 | Medium | Props: deviceId, nodes, topology links, color map. Complex sorting. Port table with link color mapping. | None (imports from `api.ts`) |
| 19 | `components/DeviceTable.jsx` | 586 | Complex | Many state variables (15+). CRUD edit modal. Bulk select/ignore. Search + sort. Role-conditional columns. `useNavigate`. Zustand store access. | None (imports from `api.ts`, `store.ts`) |
| 20 | `components/map/TopologyMap.jsx` | 440 | Complex | SVG-based interactive map. Mouse drag/zoom/pan handlers. `localStorage` state. `SVGSVGElement` refs. `createSVGPoint`, `getScreenCTM`. Complex rack/link aggregation with `useMemo`. Many event handlers with coordinate transforms. | None |
| 21 | `components/map/RackDetail.jsx` | 586 | Complex | Largest component. Multi-section layout with drag-reorder. Port link map, cable color computation. SVG link lines with `getBoundingClientRect`. Device order persistence. External/internal link categorization. | Imports `SwitchPanel.jsx` |

### 2C -- App Shell & Entry

| # | File | Lines | Complexity | Notes | Imports from JSX |
|---|---|---|---|---|---|
| 22 | `App.jsx` | 116 | Simple | Layout shell. NavLink routing. `getStoredToken`/`getStoredUser` from `api.ts`. Inline styles. | None |
| 23 | `main.jsx` | 29 | Simple | Entry point. Renders `<App>` with router and routes. Must also update `index.html` `<script>` src. | Imports `App.jsx`, `ErrorBoundary.jsx` |

---

## Phase 2 Totals

| Category | Files | Lines |
|---|---|---|
| Styles (.js -> .ts) | 2 | 131 |
| Components (.jsx -> .tsx) | 19 | 5,455 |
| App shell (.jsx -> .tsx) | 2 | 145 |
| **Total to migrate** | **23** | **5,731** |
| Files to delete (Phase 1) | 12 | 1,423 |
| **Grand total files to touch** | **35** | **7,154** |

---

## Common Typing Patterns Needed

### 1. Inline Style Objects
Nearly every component uses inline `style={{...}}` objects. Type as `React.CSSProperties` where extracted to variables. Inline JSX styles are already typed by React's JSX typings.

### 2. Event Handlers
- `onClick: React.MouseEvent<HTMLButtonElement>` or `HTMLDivElement`
- `onChange: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>`
- `onSubmit: React.FormEvent<HTMLFormElement>`
- `onMouseDown/Move/Up: React.MouseEvent<SVGSVGElement>` (TopologyMap)

### 3. Component Props Interfaces
Every component needs a `Props` interface. Common patterns:
- Callback props: `onClose: () => void`, `onFilterChange: (fn: (prev: Filters) => Filters) => void`
- Data props: reuse types from `types.ts` (`TopologyNode`, `TopologyLink`, `RackInfo`, etc.)
- Optional props with defaults: `otherRacks?: RackInfo[]`

### 4. Zustand Store
Already typed in `store.ts` with `NetmapState`. Components importing `useNetmapStore` can use selector typing.

### 5. API Module
Already typed in `api.ts`. Functions like `api.get`, `api.post`, etc. return typed responses via generics.

### 6. SVG / DOM Refs
- `useRef<SVGSVGElement>(null)` for SVG refs (TopologyMap)
- `useRef<HTMLDivElement>(null)` for scroll containers
- `useRef<HTMLInputElement>(null)` for file inputs
- `useRef<ReturnType<typeof setInterval>>(null)` for timer refs

### 7. Class Component (ErrorBoundary)
```typescript
interface ErrorBoundaryProps { children: React.ReactNode; }
interface ErrorBoundaryState { hasError: boolean; error: Error | null; }
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> { ... }
```

### 8. `as const` Assertions
For constant arrays like `CABLE_COLORS`, `NAV`, column definitions, etc.

### 9. Record / Map Types
- `positions: Record<number, {x: number; y: number}>`
- `linkColorMap: Record<string, string>`
- `portLinkMap: Record<string, LinkEntry>`
- `classMap: Record<number, SwitchClass>`

---

## Suggested Migration Order

Migrate leaf-first (no JSX dependencies) then composites, finishing with the app shell.

### Wave 1: Styles & standalone utilities (2 files, 131 lines)
1. `styles/tokens.js` -> `styles/tokens.ts`
2. `styles/shared.js` -> `styles/shared.ts`

### Wave 2: Leaf components with no JSX imports (12 files, 2,477 lines)
3. `components/map/ActiveLinkBar.jsx` -> `.tsx` (26 lines)
4. `components/ErrorBoundary.jsx` -> `.tsx` (39 lines)
5. `components/PortDetailModal.jsx` -> `.tsx` (144 lines)
6. `components/map/FilterBar.jsx` -> `.tsx` (84 lines)
7. `components/settings/DnsTab.jsx` -> `.tsx` (88 lines)
8. `components/settings/ImportExportTab.jsx` -> `.tsx` (64 lines)
9. `components/settings/MapSettingsTab.jsx` -> `.tsx` (90 lines)
10. `components/settings/RacksTab.jsx` -> `.tsx` (176 lines)
11. `components/settings/SwitchClassesTab.jsx` -> `.tsx` (201 lines)
12. `components/settings/SnmpProfilesTab.jsx` -> `.tsx` (208 lines)
13. `components/settings/SwitchModelsTab.jsx` -> `.tsx` (232 lines)
14. `components/settings/CredentialsTab.jsx` -> `.tsx` (454 lines)
15. `components/settings/ScanSettingsTab.jsx` -> `.tsx` (668 lines)

### Wave 3: Components with JSX dependencies (4 files, 1,575 lines)
_(Depends on Wave 2 components being migrated first)_
16. `components/SwitchDetailSlideIn.jsx` -> `.tsx` (241 lines) -- no JSX imports but logically paired
17. `components/Port.jsx` -> `.tsx` (188 lines) -- imports PortDetailModal
18. `components/SwitchPanel.jsx` -> `.tsx` (161 lines) -- imports Port
19. `components/DeviceTable.jsx` -> `.tsx` (586 lines) -- standalone but complex

### Wave 4: Map composites (2 files, 1,026 lines)
20. `components/map/TopologyMap.jsx` -> `.tsx` (440 lines) -- standalone, SVG-heavy
21. `components/map/RackDetail.jsx` -> `.tsx` (586 lines) -- imports SwitchPanel

### Wave 5: App shell & entry point (2 files, 145 lines)
22. `App.jsx` -> `App.tsx` (116 lines)
23. `main.jsx` -> `main.tsx` (29 lines) -- also update `index.html` script src

### Wave 6: Cleanup
- Delete all 12 duplicate `.jsx`/`.js` files from Phase 1
- Update any remaining `.jsx` import paths to drop extensions or use `.tsx`
- Run `npx tsc --noEmit` to verify zero errors
- Update `vite.config.js` if needed for entry point change

---

## Import Dependency Graph (JSX files only)

```
main.jsx
  -> App.jsx
  -> ErrorBoundary.jsx
  -> pages/* (already .tsx, import components below)

MapPage.tsx (already migrated)
  -> FilterBar.jsx
  -> TopologyMap.jsx
  -> RackDetail.jsx
    -> SwitchPanel.jsx
      -> Port.jsx
        -> PortDetailModal.jsx
  -> SwitchDetailSlideIn.jsx

SettingsPage.tsx (already migrated)
  -> SnmpProfilesTab.jsx
  -> CredentialsTab.jsx
  -> RacksTab.jsx
  -> SwitchClassesTab.jsx
  -> SwitchModelsTab.jsx
  -> ScanSettingsTab.jsx
  -> DnsTab.jsx
  -> MapSettingsTab.jsx
  -> ImportExportTab.jsx

DevicesPage.tsx / NetworkPage.tsx (already migrated)
  -> DeviceTable.jsx

DashboardPage.tsx (already migrated)
  -> (no JSX imports)

styles/shared.js -> styles/tokens.js
```

---

## Types Available in types.ts

The following interfaces are already defined and can be reused:
- `TopologyNode`, `TopologyLink`, `RackInfo`, `SwitchClass`, `SwitchModel`
- `TopologyData`, `PortInfo`, `FoundOnPort`
- `SelectedRack`, `ScanProgress`, `NetmapState`
- `DeviceTableProps`

### Types That Need to Be ADDED to types.ts

- `FilterState` -- `{ racks: Set<number> | null; classes: Set<number> | null }`
- `ZoomState` -- `{ scale: number; tx: number; ty: number }`
- `DragState` -- union type for rack/outside drag
- `LinkEntry` -- port link map entry (returned by `buildPortLinkMap`)
- `EndpointLink` -- aggregated link between racks/outside nodes
- `Credential` -- credential form/API type
- `SnmpProfile` -- already partially defined in SettingsPage.tsx
- `ScanRun` -- scan history entry
- `DiscoveryRange` -- range entry
- Props interfaces for each component (22 total)

---

## Risk Areas

1. **TopologyMap.jsx (440 lines)**: SVG coordinate transforms (`createSVGPoint`, `getScreenCTM().inverse()`) need `SVGSVGElement` and `SVGPoint` types. The `svgPoint` helper and `toContent` need explicit return types.

2. **RackDetail.jsx (586 lines)**: Complex reorder logic with index manipulation. Many `useMemo` chains. SVG line overlay with `getBoundingClientRect`. Needs careful typing of the `classSections` computed structure.

3. **ScanSettingsTab.jsx (668 lines)**: The largest file. Polling with `setInterval` refs. Multiple form state variables. Dry-run result typing. History table rendering.

4. **DeviceTable.jsx (586 lines)**: Many state variables. Generic column rendering with role-conditional columns. Sort/search logic over polymorphic device objects.

5. **Port.jsx (188 lines)**: Dynamic style injection via `document.createElement("style")`. Tooltip positioning with `getBoundingClientRect`. Needs `HTMLDivElement` ref typing.

6. **ErrorBoundary.jsx**: Class component -- React 18 class components need `Component<Props, State>` generics. `getDerivedStateFromError` is a static method with specific typing.

---

## Entry Point Consideration

`index.html` currently references:
```html
<script type="module" src="/src/main.jsx"></script>
```
After migrating `main.jsx` -> `main.tsx`, this must be updated to:
```html
<script type="module" src="/src/main.tsx"></script>
```
Vite handles `.tsx` entry points natively, so no config change needed.
