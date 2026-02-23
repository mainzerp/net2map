# SettingsPage.jsx Split Analysis

**File:** `frontend/src/pages/SettingsPage.jsx`
**Total lines:** 2149

---

## 1. Tabs / Sections and Line Ranges

| Tab key | Component name | Lines | Nav group |
|---------|---------------|-------|-----------|
| `profiles` | `SnmpProfilesTabContent` | 65–240 | CREDENTIALS |
| `switches` | `CredentialsTabContent` | 242–638 | INFRASTRUCTURE |
| `racks` | `RacksTabContent` | 640–798 | INFRASTRUCTURE |
| `classes` | `ClassesTabContent` | 800–967 | INFRASTRUCTURE |
| `models` | `ModelsTabContent` | 969–1130 | INFRASTRUCTURE |
| `scan` | `EngineTabContent` | 1132–1836 | ENGINE |
| `dns` | `DnsSettingsTabContent` | 1838–1930 | ENGINE |
| `map` | `MapSettingsTabContent` | 5–62 | APPEARANCE |
| `data` | `DataImportExportTabContent` | 1932–2000 | BACKUP |
| _(wrapper)_ | `SettingsPage` | 2003–2149 | — |

> Note: `MapSettingsTabContent` is defined at the top of the file (lines 5–62) even though its nav group is near the bottom.

---

## 2. State Variables per Tab

### `SnmpProfilesTabContent` (profiles)
Local state only — data is passed in as props:
- `editId` — id of profile being edited, or `null`
- `form` — SNMP profile form fields object
- `err` — validation / submit error string
- `confirmDeleteId` — id awaiting delete confirmation
- `formRef` — ref to form element (scroll-to on edit)

### `CredentialsTabContent` (switches)
Self-fetching component:
- `creds` — array of credential entries
- `devices` — topology nodes (to show "discovered" badge)
- `racks` — for rack dropdown
- `classes` — for class dropdown
- `loading` — initial load flag
- `editState` — `{ id, top, left }` for floating edit panel positioning
- `editFormHeight` — measured height of the "ghost" placeholder
- `form` — credential form fields object
- `err` — error string
- `confirmDeleteId`
- `formRef`, `rowRefs` — DOM refs

### `RacksTabContent` (racks)
Self-fetching:
- `racks` — array of rack records
- `devices` — topology nodes (for assign/unassign)
- `loading`
- `editId`, `form`, `err`
- `assignSel` — `{ [rackId]: deviceId }` per-rack selector value
- `confirmDeleteId`

### `ClassesTabContent` (classes)
Self-fetching, identical shape to Racks:
- `classes`, `devices`, `loading`, `editId`, `form`, `err`, `assignSel`, `confirmDeleteId`

### `ModelsTabContent` (models)
Self-fetching, identical shape to Racks/Classes:
- `models`, `devices`, `loading`, `editId`, `form`, `err`, `assignSel`, `confirmDeleteId`

### `EngineTabContent` (scan)
Largest self-contained component:
- `scanning`, `scanResult`, `activeJobId` — live scan state
- `history`, `historyLoading` — persisted scan run history
- `scanWorkers`, `snmpTimeout`, `snmpRetries` — engine tuning inputs
- `discoveryIntervalSec`, `linkUpdateIntervalSec`, `macUpdateIntervalSec` — schedule inputs
- `settingsLoading`, `settingsSaving`
- `discoveryRanges`, `rangesInput`, `rangesSaving`, `rangesError` — IP range CRUD
- `dryRunLoading`, `dryRunResult`
- `pollRef` — interval ref for job polling

### `DnsSettingsTabContent` (dns)
- `serversText`, `loading`, `saving`, `err`, `ok`

### `MapSettingsTabContent` (map)
**No local state.** Pure presentational — all state is owned by `SettingsPage` and passed as props.

### `DataImportExportTabContent` (data)
- `configDryRun`, `configData`, `configBusy`, `configMsg`

### `SettingsPage` (main wrapper)
- `activeTab` — current tab key
- `profiles`, `profLoading` — shared SNMP profile list (passed down to SnmpProfiles and Credentials tabs)
- `mapBgUrl`, `mapBgOpacity`, `mapBgScale` — map background state (passed to MapSettings tab)
- `bgFileRef` — file input ref (passed to MapSettings tab)

---

## 3. API Calls per Tab

### `SnmpProfilesTabContent`
| Method | Endpoint | Trigger |
|--------|----------|---------|
| GET | `/api/snmp-profiles` | in parent (`SettingsPage.refreshProfiles`) |
| POST | `/api/snmp-profiles` | create profile form submit |
| PUT | `/api/snmp-profiles/:id` | edit profile form submit |
| DELETE | `/api/snmp-profiles/:id` | delete confirm |

### `CredentialsTabContent`
| Method | Endpoint | Trigger |
|--------|----------|---------|
| GET | `/api/credentials` | `refresh()` on mount |
| GET | `/api/topology` | `refresh()` on mount |
| GET | `/api/racks` | `refresh()` on mount |
| GET | `/api/switch-classes` | `refresh()` on mount |
| POST | `/api/credentials` | add form submit |
| PUT | `/api/credentials/:id` | edit form submit |
| DELETE | `/api/credentials/:id` | delete confirm |

### `RacksTabContent`
| Method | Endpoint | Trigger |
|--------|----------|---------|
| GET | `/api/racks` | `refreshAll()` on mount |
| GET | `/api/topology` | `refreshAll()` on mount |
| POST | `/api/racks` | create form submit |
| PUT | `/api/racks/:id` | edit form submit |
| DELETE | `/api/racks/:id` | delete confirm |
| PATCH | `/api/topology/devices/:id/meta` `{ rack_id }` | assign / unassign device |

### `ClassesTabContent`
| Method | Endpoint | Trigger |
|--------|----------|---------|
| GET | `/api/switch-classes` | `refreshAll()` on mount |
| GET | `/api/topology` | `refreshAll()` on mount |
| POST | `/api/switch-classes` | create form submit |
| PUT | `/api/switch-classes/:id` | edit form submit |
| DELETE | `/api/switch-classes/:id` | delete confirm |
| PATCH | `/api/topology/devices/:id/meta` `{ class_id }` | assign / unassign device |

### `ModelsTabContent`
| Method | Endpoint | Trigger |
|--------|----------|---------|
| GET | `/api/switch-models` | `refreshAll()` on mount |
| GET | `/api/topology` | `refreshAll()` on mount |
| POST | `/api/switch-models` | create form submit |
| PUT | `/api/switch-models/:id` | edit form submit |
| DELETE | `/api/switch-models/:id` | delete confirm |
| PATCH | `/api/topology/devices/:id/meta` `{ model_id }` | assign / unassign device |

### `EngineTabContent`
| Method | Endpoint | Trigger |
|--------|----------|---------|
| GET | `/api/scan-settings` | on mount |
| GET | `/api/settings` | on mount |
| GET | `/api/discovery-ranges` | on mount |
| GET | `/api/scan-runs?limit=20` | `loadHistory()` on mount |
| PUT | `/api/scan-settings` | save scan settings button |
| PUT | `/api/settings/discovery_interval_sec` | save scan settings button |
| PUT | `/api/settings/link_update_interval_sec` | save scan settings button |
| PUT | `/api/settings/mac_update_interval_sec` | save scan settings button |
| PUT | `/api/settings/port_update_interval_sec` | save scan settings button |
| PUT | `/api/discovery-ranges` | save ranges button |
| POST | `/api/scan/jobs` | run scan button |
| POST | `/api/scan/dry-run/jobs` | dry run button |
| GET | `/api/scan/jobs/:id` | polling (1500ms) |
| POST | `/api/scan/jobs/:id/cancel` | cancel button |

### `DnsSettingsTabContent`
| Method | Endpoint | Trigger |
|--------|----------|---------|
| GET | `/api/dns-settings` | on mount |
| PUT | `/api/dns-settings` | save button |

### `MapSettingsTabContent`
No direct API calls — all handled in `SettingsPage`.

### `DataImportExportTabContent`
| Method | Endpoint | Trigger |
|--------|----------|---------|
| GET | `/api/config/export` | export button |
| POST | `/api/config/import` | import button |

### `SettingsPage`
| Method | Endpoint | Trigger |
|--------|----------|---------|
| GET | `/api/snmp-profiles` | `refreshProfiles()` on mount |
| GET | `/api/map-background` (raw fetch) | on mount |
| GET | `/api/map-settings` | on mount |
| POST | `/api/map-background` (FormData, raw fetch) | file upload |
| DELETE | `/api/map-background` (raw fetch) | remove button |
| PUT | `/api/map-settings` | opacity/scale slider changes |

---

## 4. Shared State and Functions

| Thing | Owned by | Consumed by |
|-------|----------|-------------|
| `profiles` (SNMP profile list) | `SettingsPage` | `CredentialsTabContent`, `SnmpProfilesTabContent` |
| `profLoading` | `SettingsPage` | `SnmpProfilesTabContent` |
| `refreshProfiles()` | `SettingsPage` | `SnmpProfilesTabContent` (as `onChanged`), `DataImportExportTabContent` (as `onProfilesChanged`) |
| `mapBgUrl`, `mapBgOpacity`, `mapBgScale` | `SettingsPage` | `MapSettingsTabContent` (all via props) |
| `bgFileRef` | `SettingsPage` | `MapSettingsTabContent` |
| `uploadMapBg`, `removeMapBg`, `changeBgOpacity`, `changeBgScale` | `SettingsPage` | `MapSettingsTabContent` |

The following **constants** are currently imported in the top-level file and used by two tabs:
- `AUTH_PROTOCOLS`, `PRIV_PROTOCOLS`, `SEC_LEVELS` — used by both `SnmpProfilesTabContent` and `CredentialsTabContent`; both new files must import them from `../../api.js`.

---

## 5. What SettingsPage Owns and Renders

**State owned:**
- `activeTab` — controls which tab is visible
- `profiles` + `profLoading` — shared SNMP profile data
- `mapBgUrl`, `mapBgOpacity`, `mapBgScale`, `bgFileRef` — map background state

**Logic owned:**
- `refreshProfiles()` — GET /api/snmp-profiles, sets state
- `uploadMapBg(file)`, `removeMapBg()`, `changeBgOpacity(val)`, `changeBgScale(val)` — map background CRUD

**Renders:**
- A two-column layout: left sidebar nav + right content area
- Sidebar: `NAV_GROUPS` constant (tab groups/labels/descriptions), maps to nav buttons that call `setActiveTab`
- Content area header: title + description from `allNavItems.find(n => n.tab === activeTab)`
- Content body: conditional rendering of each tab component

---

## 6. Proposed Split

### Files to create

```
frontend/src/components/settings/
  SnmpProfilesTab.jsx
  CredentialsTab.jsx
  RacksTab.jsx
  SwitchClassesTab.jsx
  SwitchModelsTab.jsx
  ScanSettingsTab.jsx
  DnsTab.jsx
  MapSettingsTab.jsx
  ImportExportTab.jsx
```

### Per-file plan

#### `SnmpProfilesTab.jsx`
- Move: `EMPTY_PROFILE_FORM` constant + `SnmpProfilesTabContent` function
- Rename export to `SnmpProfilesTab`
- Imports: `{ useState, useRef }` from react; `{ api, AUTH_PROTOCOLS, PRIV_PROTOCOLS, SEC_LEVELS }` from `../../api.js`
- Props: `{ profiles, loading, onChanged }`

#### `CredentialsTab.jsx`
- Move: `EMPTY_FORM` constant + `CredentialsTabContent` function
- Rename export to `CredentialsTab`
- Imports: `{ useState, useEffect, useRef }` from react; `{ api, AUTH_PROTOCOLS, PRIV_PROTOCOLS, SEC_LEVELS }` from `../../api.js`
- Props: `{ profiles }`

#### `RacksTab.jsx`
- Move: `EMPTY_RACK_FORM` constant + `RacksTabContent` function
- Rename export to `RacksTab`
- Imports: `{ useState, useEffect }` from react; `{ api }` from `../../api.js`
- Props: none

#### `SwitchClassesTab.jsx`
- Move: `EMPTY_CLASS_FORM` constant + `ClassesTabContent` function
- Rename export to `SwitchClassesTab`
- Imports: `{ useState, useEffect }` from react; `{ api }` from `../../api.js`
- Props: none

#### `SwitchModelsTab.jsx`
- Move: `EMPTY_MODEL_FORM` constant + `ModelsTabContent` function
- Rename export to `SwitchModelsTab`
- Imports: `{ useState, useEffect }` from react; `{ api }` from `../../api.js`
- Props: none

#### `ScanSettingsTab.jsx`
- Move: `EngineTabContent` function (largest tab, ~700 lines)
- Rename export to `ScanSettingsTab`
- Imports: `{ useState, useEffect, useRef }` from react; `{ api }` from `../../api.js`
- Props: none

#### `DnsTab.jsx`
- Move: `DnsSettingsTabContent` function
- Rename export to `DnsTab`
- Imports: `{ useState, useEffect }` from react; `{ api }` from `../../api.js`
- Props: none

#### `MapSettingsTab.jsx`
- Move: `MapSettingsTabContent` function
- Rename export to `MapSettingsTab`
- Imports: none (pure presentational, no hooks, no api)
- Props: `{ url, opacity, scale, fileRef, onUpload, onRemove, onChangeOpacity, onChangeScale }`

#### `ImportExportTab.jsx`
- Move: `DataImportExportTabContent` function
- Rename export to `ImportExportTab`
- Imports: `{ useState }` from react; `{ api }` from `../../api.js`
- Props: `{ onProfilesChanged }`

### Slimmed-down `SettingsPage.jsx`
After the split, `SettingsPage.jsx` will contain only:
- Imports of all 9 tab components
- Import of `{ api, API }` from `../api.js`
- Import of `{ useState, useEffect, useRef }` from react
- `NAV_GROUPS` constant
- `SettingsPage` default export with:
  - All state variables listed in section 5
  - `refreshProfiles`, `uploadMapBg`, `removeMapBg`, `changeBgOpacity`, `changeBgScale`
  - Sidebar render
  - Content area render with tab switching

Estimated size of slimmed `SettingsPage.jsx`: ~130–150 lines.

---

## 7. Tab Navigation After the Split

The navigation mechanism **does not need to change**. It currently works as:

1. `activeTab` state (string key) lives in `SettingsPage`
2. Sidebar buttons call `setActiveTab(tab)` on click
3. Content area uses conditional rendering:
   ```jsx
   {activeTab === "switches" && <CredentialsTab profiles={profiles} />}
   {activeTab === "profiles" && <SnmpProfilesTab profiles={profiles} loading={profLoading} onChanged={refreshProfiles} />}
   {/* etc. */}
   ```

This approach means **inactive tabs are unmounted** — they re-fetch their own data on every tab navigation. This is the existing behavior and can be kept as-is after the split. If lazy loading or state persistence across tab changes becomes desirable in the future, the tab components could be wrapped in CSS `display:none` instead of `&&`, but that is out of scope here.

No router change is needed; the whole settings page uses a local sidebar nav, not URL-based routing.

---

## Key Observations / Caveats

1. **`CredentialsTabContent` has a floating edit panel** (fixed-position popup) that measures the height of the "ghost" placeholder, requires `rowRefs` to get the row bounding rect, and sets `editState.top/left` dynamically. This is self-contained within the component and moves cleanly to `CredentialsTab.jsx` without changes.

2. **`EngineTabContent` uses `useRef` for polling** (`pollRef`) and cleans it up in a `useEffect` return. This stays self-contained.

3. **`MapSettingsTabContent` is defined at line 5** but its nav entry is in the APPEARANCE group. The file order does not matter after the split since it becomes its own module.

4. **`AUTH_PROTOCOLS`, `PRIV_PROTOCOLS`, `SEC_LEVELS`** are imported from `api.js` at the top of the file and used in both `SnmpProfilesTabContent` and `CredentialsTabContent`. Each new file must independently import them from `../../api.js`.

5. **`API` (base URL string)** is used by `SettingsPage` for raw `fetch()` calls to the map background endpoint. It must remain imported in the slimmed `SettingsPage.jsx`.
