# Net2Map User Guide

How to operate Net2Map in the browser: log in, run scans, read the topology
map, manage devices and racks, and maintain your data. This guide covers the
web UI only.

Related docs:

- [README.md](../README.md) - quickstart (Docker), project overview
- [OPERATIONS.md](OPERATIONS.md) - deployment, environment variables, server-side troubleshooting
- [BACKUP.md](../BACKUP.md) - database backup and restore
- [API.md](API.md) - REST API reference (`/api/v1`)

## Prerequisites

- The Net2Map stack is running (see the [README](../README.md) quickstart).
- The UI is reachable at `http://localhost:3000` (host port `3000`; a different
  `NET2MAP_PORT` changes this).
- The switches must be reachable via SNMP (UDP 161) from the host running the
  stack, and you need their SNMP credentials (v2c community or v3 user).

## Logging in and roles

The login page (`/login`) shows `Net2Map Login` with `Username` and
`Password` fields and a `Sign In` button. The exact mode depends on how the
backend is configured (see [OPERATIONS.md](OPERATIONS.md)):

- **User accounts (JWT enabled):** sign in with username and password. On a
  fresh install one `admin` account exists; its initial password is the
  `DEFAULT_ADMIN_PASSWORD` value set at deployment time. Change it after the
  first login.
- **Access token:** "Use an access token instead" opens a field where you paste
  an access token (the legacy static token or a JWT). "Use username and
  password" returns to the login form. A valid static token authenticates as a
  read/write `admin` session.
- **No auth configured:** the app loads without a login page and every user has
  full access.

Login attempts are rate-limited; wait a minute and retry if `Sign In` keeps
failing with an error.

Roles:

- **admin** - everything: write access plus admin-only actions (delete
  credentials, profiles, racks, classes, models and endpoints; configuration
  and bulk import; user management via the API).
- **operator** - day-to-day operation: create and edit settings, credentials,
  racks, classes, models, device metadata, rack placement and map positions;
  start and cancel scans; run dry runs. Cannot delete or import.
- **viewer** - read-only. Can browse all pages and open the inspector, but
  cannot save changes or start scans. The rack elevation shows
  "View-only: sign in as operator or admin to rearrange devices", and the
  `Monitor latency` checkbox in the device inspector is disabled.

Sessions and logout:

- A login session expires after the configured JWT lifetime (24 hours by
  default). Expired sessions send you back to the login page.
- `Logout` is in the sidebar user card, next to your username and role.
  Logging out revokes the session server-side where revocation is available
  and always clears the local session.
- There is no user-management page in the UI; admins manage users and password
  changes through the API (see [API.md](API.md)).
- The sidebar collapses with `Collapse sidebar` / expands with
  `Expand sidebar`.

## First steps: getting your first map

All setup happens under `Settings` in the sidebar. The page opens on the
`Switches` tab by default.

1. **SNMP access - `Settings > Profiles` (optional but recommended).** Create a
   reusable SNMP profile with `+ New Entry`: `SNMP Version` `v2c` (community
   string) or `v3` (security level, username, auth/priv protocols and
   passwords). Defaults: `v2c`, community `public`, v3 `authPriv` with
   `SHA-256`/`AES-128`.
2. **Switches - `Settings > Switches`.** Add each switch with `+ New Entry`:
   `IP`, `SNMP Version`, credentials or a profile reference, `SNMP Port`
   (default `161`), `Priority` (`0` = primary; additional entries for the same
   IP are tried in priority order) and `Include in scan`. A `v3` credential can
   override the `Engine ID` via "Set engine ID override" when the engine ID
   differs from the switch IP.
3. **Discovery ranges - `Settings > Scan`, section `Discovery ranges`.** Enter
   IPs or CIDR ranges (one per line, or separated by commas/semicolons), e.g.
   `192.168.1.0/24`, and save with `Save Ranges`. Discovery scans probe these
   ranges and create credentials for hosts that answer SNMP. `Dry Run` is
   disabled until at least one range is saved.
4. **DNS - `Settings > DNS` (optional).** Add DNS resolver IPs for reverse
   (PTR) lookups; save with `Save DNS Settings`. Empty uses the system
   resolver.
5. **Run the scan.** Either press `Start scan` on the Dashboard or `Run Scan`
   under `Settings > Scan`. The dashboard shows live progress
   (`Scanning N of M`, percentage, last scanned IP); the map highlights hosts
   while they are scanned.
6. **View the result.** Open `Topology` in the sidebar. The map shows
   discovered switches, racks and links. Find your switches under `Network`,
   the attached end devices under `Devices`, and place switches into racks
   under `Racks` or `Settings > Racks`.

Tip: use `Dry Run` on the scan settings tab before the first real run to see
which hosts in the discovery ranges would respond and whether a profile
matches.

## Pages

The sidebar lists the pages in this order:

### Dashboard (`/`)

![Dashboard](screenshots/dashboard.png)

The operation overview. The headline states switch health in one sentence
("All N switches online." / "N switches online. N need attention." /
"No switches discovered yet."), followed by a fact line with counts -
`devices`, `endpoints`, `links`, `ports up`, `racks` (each links to the
matching page) - and `Last scan` (timestamp or `never`). Before the first
scan the hint "Add credentials in Settings and run a scan." is shown instead.

- `Network scan` panel: `Start scan` (or `Cancel` / `Cancelling...` while a
  scan runs). Live progress shows `Scanning N of M`, a percentage bar and the
  latest IP. The last run shows timestamp and status; failures show
  `Scan failed: <error>`. Before the first run it reads "No scan has run yet.
  Start a scan to discover your network."
- `Attention needed`: lists issues that need action - `Failed` (last scan
  failed; opens `Settings > Scan`), `Offline` (a switch is unreachable; opens
  the device inspector), `No rack` and `Ignored` (both open the `Network`
  page). When nothing is flagged it reports that all devices are reachable,
  no scans failed and every switch is placed in a rack.
- `Latency`: network Median, p95, Loss and Reachable with a median sparkline,
  history range `1h` / `24h` / `7d`, and up to five problem devices. When the
  monitor is off it shows "The latency monitor is disabled." with an
  `Enable it in Settings` link; see [Latency monitor](#latency-monitor).
- `Composition`: `Vendors` (top five by device count) and `Link speeds`
  (`>=10G`, `1G`, `<=100M`).
- `Racks overview` (only when racks exist): one row per rack with `Rack`,
  `Room`, `Switches`, `Ports` and an `Active` port-utilization bar;
  `Open racks` goes to `/racks`.
- Quick navigation links: `Topology map`, `Devices`, `Settings`.
- `Refresh` re-fetches the dashboard data.

### Topology (`/map`)

![Topology map](screenshots/topology.png)

Interactive topology map (React Flow). Racks render as collapsed boxes, devices
without a rack as standalone nodes; links between switches are drawn from LLDP
data. The header shows `N Switches`, `N x >=10G`, `N x 1G` and an
`updated Ns ago` indicator.

Toolbar:

- `Search device (name / ip)...` filters and focuses devices.
- `RACKS` and `CLASSES` chips filter the visible nodes; `Clear filters` resets
  them.
- `Flow` toggles the animated flow overlay on active links (preference is
  remembered).
- `Auto-Layout` re-lays out the map and persists positions (hidden when the
  active floor has a floor plan background image). `Reset Zoom` restores the
  default view; the viewport position itself is remembered between visits, per
  floor.
- `Off` clears the logical layer.

Logical layers (top-left legend explains the colors while a layer is active):

- `STP` - spanning tree: crown marks the root bridge, arrows point along root
  paths, dashed red marks blocked links. Warns `N STP domains` when more than
  one root is present. Disabled if no STP data exists.
- `VLAN` - pick a VLAN from the selector; links and devices carrying that VLAN
  are highlighted (tagged, untagged "U", member-port counts `n`), others fade.
  Disabled if no VLAN data exists.
- `Latency` - links tinted by latency status (green = both ends OK, yellow =
  degraded/packet loss, red = an endpoint is down, grey = no data; edge labels
  show the highest endpoint RTT). Disabled when the latency monitor is off.

![Topology layer VLAN](screenshots/topology-vlan.png)
![Topology layer STP](screenshots/topology-stp.png)
![Topology layer Latency](screenshots/topology-latency.png)

Interactions:

- Click a device node to open its inspector. Click a rack box to open the rack
  side panel (see below). Drag nodes to reposition them (saved automatically;
  requires operator or admin rights).
- While a scan runs, a sweep line crosses the canvas and the currently scanned
  IP pulses; the map refreshes when the scan finishes.
- Zoom range is limited (`0.15`-`6`); a minimap sits bottom-right, zoom
  controls bottom-left.
- Empty map message: "No switches found - add credentials in Settings and run
  Scan".

Rack side panel (open a rack box):

- Shows the rack's `Rack elevation (N)` grid and `Unplaced (N)` devices with a
  `Place in rack elevation` link to `/racks`.
- Device rows group into `Uplinks`, `TOR Trunks`, `Inter-Rack` (devices wired
  to other racks), `Cable Map` and by class. Click a port `(*)` or a cable map
  row to highlight the connection in red. The `<>` button (`Change rack`) on a
  device row opens an `Assign to rack:` picker to move it to another rack.
- `Edit` renames the rack inline (`OK`/`X` to confirm/cancel); `Details`
  opens the rack inspector.
- The cable map lists inter-rack connections `local port -> remote : port` with
  speed.

#### Buildings, floors and portals

A site can be modelled as buildings with floors (`Settings > Buildings &
floors`). Each floor has its own floor plan background, opacity, zoom and
canvas color. Once at least one floor exists:

- The map shows exactly one floor at a time. A floor switcher sits at the top
  left of the canvas: a building select (only with more than one building) and
  one tab per floor, ordered as in the settings, each with its device count.
  Use the arrow keys to move between tabs.
- The active floor is remembered in the browser and reflected in the URL
  (`/map?floor=<id>`), so a link opens the same floor; a floor in the URL wins
  over the remembered one. Without either, the first floor of the first
  building is shown.
- Racks are assigned to floors in `Settings > Racks` or in the rack inspector;
  devices outside racks in the device inspector (`Floor`) or in bulk via
  `Move to floor...` on the Network page. Racked devices always follow their
  rack's floor.
- Racks and devices without a floor (for example devices found by a new scan)
  appear on the `Unassigned` tab, which is only shown while something is
  unassigned; its badge shows how many devices are waiting for a floor.
- Links to a rack or device on another floor are drawn as dashed edges to a
  portal node labelled `<floor> / <rack or device>` (with the building name
  when it is in another building). Click a portal to switch to that floor and
  focus the remote device.
- `Show on map`, the toolbar search and port deep links switch to the target
  floor first and then focus the device.

Without any floors the map works as before: one canvas, all racks and devices,
no background image.

### Devices (`/devices`)

![Endpoints](screenshots/devices.png)

End devices found through switch MAC tables ("Clients and endpoint devices
discovered via switch MAC tables"), split into `ACTIVE ENDPOINTS` and
`IGNORED ENDPOINTS` sections. Columns: `MAC`, `IP`, `Hostname`,
`First Seen`, `Last Seen`, `Found On`, `Actions`.

- `Search endpoints...` filters both sections; the term is stored in the URL
  (`?q=`) so a filtered list is linkable.
- Click a row to open the endpoint inspector. Click `Found On` (switch : port)
  to jump to `/map` with that port highlighted.
- `Ignore` moves an endpoint to the `IGNORED ENDPOINTS` section (rows shown
  dimmed); `Re-enable` restores it. Ignored endpoints are excluded from
  display elsewhere but remain in the database.
- Checkboxes enable the bulk toolbar (`N selected`): `Ignore Selected`,
  `Re-enable Selected`, `Clear`.
- Empty state: "No endpoint devices discovered yet".

Endpoint inspector: name, `Ignored` badge, Details (MAC, IP, Hostname, Vendor,
`First Seen`, `Last Seen`), `Notes` (editable), `Seen on` (port history: which
switch/port the endpoint was found on, with VLAN badge), and `Go to port` to
jump to the map.

### Network (`/network`)

![Network devices](screenshots/network.png)

Managed infrastructure ("Managed network equipment (switches, routers,
firewalls)"), split into `ACTIVE NETWORK DEVICES` and
`IGNORED NETWORK DEVICES`. Columns: `Name`, `IP`, `MAC`, `Rack`, `Class`,
`Model`, `Firmware`, `Location`, `Last Seen`, `Status`.

- `Search name or IP...` and the status dropdown (`All statuses`, `Online`,
  `Offline`, `Unknown`) filter the list; both are reflected in the URL
  (`?q=`, `?status=`) so a filtered view is linkable. `Status` shows
  `online`/`offline`/`unknown` with the ping RTT when online.
- Click a row to open the device inspector (details, latency, spanning tree,
  ports table with status/speed/VLAN/STP/endpoint counts, neighbors).
- `Edit` opens `Edit device` to assign `Rack`, `Class` and `Model`
  (`-- No rack --`, `-- No class --`, `-- No model --` clear them).
- `Ignore` / `Re-enable` toggles the ignored flag. Ignored devices are excluded
  from scans and hidden from the topology map, but remain in the database and
  can be re-enabled at any time.
- Checkboxes enable the bulk toolbar (`N selected`): `Ignore Selected`,
  `Re-enable Selected`, `Clear`.

### Racks (`/racks`)

![Rack elevation](screenshots/racks.png)

Rack elevation view. `U1` is at the bottom, higher U numbers at the top. With
no racks defined the page shows "No racks defined yet" and a `Manage racks`
link.

- `Select rack` dropdown lists racks as `Label (room) - NU`. Devices display
  as blocks spanning their U height; devices without a U height count as `1U`.
- `Manage racks` opens `Settings > Racks` (definitions). `/racks?rack=<id>`
  deep-links to a specific rack.
- `Activity` toggles a subtle blink animation on up-port LEDs (off by
  default, not offered when reduced motion is preferred).
- Drag and drop: drag a device from the trays (`Unplaced in this rack`,
  `No rack assigned`) onto free U positions or rearrange inside the rack. A red
  preview marks an invalid placement (overlap or out of range). Positions save
  on drop.
- `U height`: the `-` / `+` stepper on each placed device changes its height
  (`1`-`4U`) and saves immediately.
- Click a device name to open its inspector. Click a port to highlight the
  connected remote port.
- Viewers see a read-only view; operators and admins can rearrange.

Rack definitions live under `Settings > Racks`.

### Logs (`/logs`)

![Log view](screenshots/logs.png)

"Structured backend events (JSON)". Requires `admin` or `operator`.

- Filters: `Filter by level` (`All levels`, `INFO`, `WARNING`, `ERROR`),
  `Event prefix` (e.g. `scan`, `auth`, `latency`), payload search
  (`search payload text`), and `Limit` (`100`/`300`/`500`/`1000`/`2000`,
  default `300`).
- `Auto refresh` (on by default) polls every 5 seconds; `Refresh` reloads
  manually.
- Columns: `Time`, `Level`, `Event`, `Payload` (expandable JSON). Pages of
  100 rows with `Prev`/`Next`.

### Settings (`/settings`)

`/settings` redirects to `/settings/credentials` ("Switches"). The tabs are
grouped as `Credentials` (`Switches`, `Profiles`), `Infrastructure` (`Racks`,
`Classes`, `Models`), `Engine` (`Scan`, `DNS`), `Appearance` (`Map`) and
`Backup` (`Backup & Restore`). Tabs with entries offer `+ New Entry` next to
the tab bar.

#### `Switches` (credentials)

SNMP credentials per switch IP. Fields: `Label`, `IP`, `Priority`
(`0` = primary; additional credentials for the same IP are tried in priority
order), `SNMP Version` (`v2c`/`v3`), `SNMP Port` (default `161`), credential
fields, `SNMP profile` reference, `Engine ID` (v3 override), `Include in scan`.
Defaults: `v2c`, community `public`, v3 `authPriv`/`SHA-256`/`AES-128`.

- Each credential card shows label, `ip:port`, the SNMP version badge, the
  community/username or linked profile label, and status badges: the rack the
  device sits in (or `no rack`), `discovered` (matched to a scanned device)
  and `ignored`. v3 cards also show the `Engine ID` (or "not yet discovered")
  plus an `override` badge when a manual engine ID is set. Disabled
  credentials are dimmed.
- Secrets are masked as `***`; leave secret fields empty when editing to keep
  the stored value.
- `DISCOVERED WITHOUT CREDENTIALS` lists devices seen in scans but without a
  working credential (`unassigned` badge); `+ Add credentials` opens a
  prefilled new-credential form for that IP.

#### `Profiles`

Reusable SNMP profiles (`v2c` or `v3` with the same protocol options).
Referenced by credentials via `SNMP profile`. `Create profile`, `Edit`,
`Delete` (asks to confirm; `Delete Profile` cannot be undone). The form warns
when the community is `public`.

#### `Racks`

Rack definitions: `Label` (required), `Room`, `Description`, `Height (U)`
(default `42`, allowed `6`-`60`), and `Floor` (once floors exist; each rack
card shows its `Building / Floor`). `Create rack`, `Edit`, `Delete`, and
`Open elevation` jumps to `/racks`. Deleting a rack unassigns its switches.

#### `Classes`

Switch classes (roles/colors for grouping and filtering). Fields: `Label`
(required), `Color` (default `#5a86b8`), `Description`, and
`Allow outside rack placement` - when off (`Rack required` badge), switches of
that class must sit in a rack. `Available devices`/`Assigned devices` let you
assign switches; the count column shows `N` per class. Deleting a class
unassigns its switches.

#### `Models`

Hardware models that drive the port-layout rendering. Fields: `Name`
(required), `Ports per row` (default `24`, up to `96`), optional
`Total ports (cutoff)` to hide ports beyond a count for partly populated
models, `Description`. Assign devices per model; `Delete` unassigns them.

#### `Scan`

![Scan settings](screenshots/settings-scan.png)

- `Discovery ranges`: IPs/CIDRs to probe; `Save Ranges`; `Dry Run` (preview,
  no writes; result shows found/probed hosts and per-host badges `existing`,
  `no profile suitable`, `would create credential`). Disabled without ranges.
- `Scan engine`: `Parallel Workers (Hosts)` `1`-`128` (default `12`),
  `Timeout (s)` `1`-`30` (default `3`), `Retries` `0`-`10` (default `1`),
  `Bulk Size` `5`-`100` (default `25`); `Save Scan Settings`.
- `Intervals`: `Discovery Full Scan Interval (sec)` `0`-`86400` (default
  `1800`), `LLDP Link Poll Interval (sec)` `0`-`3600` (default `60`),
  `MAC Poll Interval (sec)` `0`-`3600` (default `300`),
  `VLAN Refresh Interval (sec)` `0`-`86400` (default `1800`, `0` = manual full
  scans only), `STP Refresh Interval (sec)` `0`-`86400` (default `300`, `0` =
  manual full scans only).
- `Latency monitor`: see [Latency monitor](#latency-monitor).
- `Run Scan` starts a manual full scan (`Scanning...`, `Cancel`); the result
  panel reports `SCANNED`, `FOUND`, `LINKS`, `TOTAL TIME`, `WORKERS`, a
  `SWITCH DURATIONS` table (`SWITCH`, `TIME`, `STATUS`) and `ERRORS (N)`.
- `SCAN HISTORY (persisted)`: one row per finished run - `OK`/`CAN`/`ERR`
  status, duration, device/link diffs (`+dev`, `-dev`, `+link`, `-link`), and
  expandable `New devices`, `Removed devices`, `New links`, `Removed links`
  with `Show all`/`Show less`.

#### `DNS`

`DNS RESOLVER`: DNS server IPs used for reverse lookup of peer hostnames
during scans - one per line. `Save DNS Settings` applies; leaving it empty
uses the system/default DNS resolver.

#### `Buildings & floors`

Buildings and their floors for the topology map (replaces the former global
`Map` background settings; `/settings/map` redirects here). `Add building` and
`Add floor` create entries; names are edited inline (Enter or leaving the field
saves) and the arrow buttons change the order. Deleting a building or floor
(admin only, with confirmation) never deletes racks or devices: they become
unassigned and show up on the map's `Unassigned` tab.

`Background` on a floor opens its floor plan settings: `Upload image` /
`Replace image` / `Remove image` (PNG, JPG, GIF, WEBP or SVG, max 20 MB),
`Opacity` (`0.05`-`1`, default `0.3`), `Image zoom` (`0.1`-`5`), and the canvas
color - `Follow theme` or `White`/custom color. A floor with a floor plan hides
`Auto-Layout` while it is the active floor. Viewers see the settings read-only.

#### `Backup & Restore`

`GLOBAL BACKUP & RESTORE` exports or imports the full configuration: app
settings, SNMP profiles and credentials (not scan/device data - for database
backup see [BACKUP.md](../BACKUP.md)).

- `Export Config` downloads a JSON file. Secrets are exported masked.
- Paste JSON into the textarea and `Import Config` to apply it. `Dry-run
  restore` (checked by default) validates without writing; the result reports
  per-section totals (`settings`, `profiles`, `credentials`) and row errors.
- Export requires `admin` or `operator`; import requires `admin`.

## Cross-cutting tools

### Inspector drawer

A right-side drawer shows details for a `Switch`, `Endpoint` or `Rack`. It
opens from table rows, map nodes, dashboard cards and the command palette, and
closes with `X` or `Esc`. It is deep-linkable via the URL -
`?inspect=device:<id>`, `?inspect=endpoint:<id>`, `?inspect=rack:<id>` - and
the browser Back button closes it. Recently inspected targets appear in the
command palette's `Recent` group.

![Inspector](screenshots/inspector.png)

The switch inspector shows `Show on map` (centers the map on the device),
`Open rack`, `Details` (hostname, model, MAC, firmware, location, rack), the
`Latency` section, `Spanning tree` (when data exists), a `Ports` table
(status, speed, VLAN, STP role/state, endpoint count) and `Neighbors`
(discovered links; click a neighbor to switch to it).

### Command palette

Open with `Ctrl+K` / `Cmd+K`, or `/` when not typing. Search field:
"Search switches, endpoints, racks, ports or commands...". Results group into
pages, `Start scan` and `Toggle theme` actions, switches, endpoints, racks and
ports; selecting a device, endpoint or rack opens its inspector. `Up`/`Down`
to move, `Enter` to open, `Esc` to close.

![Command palette](screenshots/command-palette.png)

### Theme and keyboard shortcuts

- The sidebar sun/moon button toggles `Switch to light theme` / `Switch to
  dark theme`. Light is the default; the choice is persisted in the browser.
- Number keys `1`-`7` jump to pages: `1` Dashboard, `2` Topology, `3` Devices,
  `4` Network, `5` Logs, `6` Settings, `7` Racks.
- `s` starts a scan (operator/admin; viewers get a failure toast).
- `Esc` closes the current dialog/inspector.
- Shortcuts do not fire while typing in an input, while a dialog is open, or
  with modifier keys.

## Scans explained

Net2Map scans switches over SNMP on several schedules plus manual runs.

Scan types:

- **Discovery (full)**: probes the configured `Discovery ranges`, scans all
  enabled credentials, refreshes interface names, VLAN and STP data, and
  auto-creates credentials for range hosts that answer. Manual `Run Scan` /
  `Start scan` runs a full scan. Default interval `1800` s.
- **Links (LLDP)**: refresh link/neighbor, port status and speed data. Default
  interval `60` s; `0` disables it.
- **MAC**: refresh MAC tables (endpoints) and, once their own intervals have
  elapsed, VLAN and STP data. Default interval `300` s; `0` disables it.
- **VLAN / STP**: not separate scans - refreshed inside MAC scans when their
  interval has elapsed; `0` means only during manual full scans.

Scheduling and concurrency:

- Scheduled scans dispatch in priority order MAC > links > discovery; a
  higher-priority scan preempts a queued lower-priority one. The scheduler
  falls back to the defaults above if no intervals are stored.
- One scan runs at a time (a scan lock prevents concurrent runs). Starting a
  scan while another is active fails with "Scan could not be started (another
  scan is active)".
- A scan can be cancelled while running (`Cancel`); cancelled runs appear in
  history as `CAN`.
- With Redis configured, jobs run on the Celery worker; otherwise a background
  thread in the API process runs them (see [OPERATIONS.md](OPERATIONS.md)).

Progress and results:

- Live progress streams to the Dashboard and the map (progress bar, scanned
  IPs, sweep overlay).
- The `Settings > Scan` result panel reports per-switch durations and errors;
  `SCAN HISTORY` lists persisted runs with device/link diffs.
- `Dry Run` previews discovery ranges without writing anything.

Scan scope details:

- Only credentials with `Include in scan` enabled are scanned; several
  credentials per IP are tried in `Priority` order.
- Ignored devices are excluded from scans and from the topology map.
- Every scanned device is pinged once; the result drives the
  `online`/`offline`/`unknown` status shown in tables and the map.

## Maintaining data

- **Device metadata**: `Edit` on the `Network` page assigns `Rack`, `Class`
  and `Model`. Vendor and other detected fields are refreshed by scans; the
  API additionally supports per-device overrides (vendor override, label,
  sysName, location, U height - see [API.md](API.md)).
- **Classes**: `Settings > Classes` defines colored roles; `Allow outside rack
  placement` controls whether members may sit outside a rack.
- **Models**: `Settings > Models` defines port layouts (`Ports per row`,
  optional `Total ports` cutoff) used for port visualization.
- **Racks and placement**: `Settings > Racks` defines racks; `/racks` assigns
  and positions devices by drag and drop and sets `U height`.
- **Ignoring**: `Ignore`/`Re-enable` on `Network` (devices) and `Devices`
  (endpoints). Ignored devices are skipped by scans and hidden on the map;
  ignored endpoints are hidden but kept.
- **Full configuration**: `Settings > Backup & Restore` exports/imports
  settings, profiles and credentials as JSON. CSV/JSON bulk import/export of
  credentials and profiles is available through the API (see [API.md](API.md)).

## Latency monitor

A dedicated service continuously pings monitored devices and records
round-trip time, jitter, packet loss and a 24 h baseline.

Configuration lives in `Settings > Scan`, section `Latency monitor`:

- `Enable latency monitor` toggles the service.
- `Interval (s)` `5`-`300` (default `10`): seconds between ping rounds.
- `Pings per round` `1`-`10` (default `3`): pings per device per round.
- `Mode`: `All enabled devices` or `Selected devices only`. In `selected` mode,
  tick `Monitor latency` in a device's inspector (`Latency` section) to include
  it.
- `Retention (days)` `1`-`365` (default `30`): how long latency history is
  kept; `Save Latency Settings` applies changes.

Where you see it:

- **Dashboard `Latency` card**: network-wide `Median`, `p95`, `Loss`,
  `Reachable`, a median sparkline and history ranges `1h`/`24h`/`7d`; up to
  five problem devices with `Degraded`/`Packet loss`/`Down`. If disabled, the
  card links to `Enable it in Settings`; if the service stopped, it warns
  "The latency-monitor service is not running."
- **Device inspector `Latency` section**: `RTT`, `Jitter`, `Loss` and
  `Baseline` versus the 24 h median, plus a history chart (`1h`/`24h`/`7d`)
  and the `Monitor latency` checkbox (viewers cannot change it).
- **Topology `Latency` layer**: links colored by endpoint status with the
  highest endpoint RTT as the edge label.
- Statuses: `OK` (healthy), `Degraded` (RTT above baseline), `Packet loss`,
  `Down` (device unreachable), `unknown` (no data). Changes write
  `latency_status_change` events visible under `Logs`.

## Troubleshooting (browser-side)

- **No devices on the map**: the map shows "No switches found - add
  credentials in Settings and run Scan". Check that credentials exist and have
  `Include in scan` enabled (`Settings > Switches`), that discovery ranges are
  saved (`Settings > Scan`), then `Run Scan`.
- **SNMP timeouts / devices not found**: a credential shows as failed in the
  scan errors list (`Settings > Scan` result panel, `ERRORS`). Verify the
  version/community/v3 user for that IP, raise `Timeout (s)` or `Retries` in
  `Scan engine`, and confirm the switch answers SNMP from the stack (see
  [OPERATIONS.md](OPERATIONS.md)).
- **`DISCOVERED WITHOUT CREDENTIALS` entries**: the device answered discovery
  but no credential worked - add one via `+ Add credentials` on the entry.
- **Missing links**: links come from LLDP; they need a recent links scan
  (`LLDP Link Poll Interval` not `0` or a manual full scan) and LLDP enabled on
  the switches.
- **`HTTP 403` / "Requires role" errors**: your role does not allow the
  action - viewers are read-only and some actions are admin-only (see
  [Logging in and roles](#logging-in-and-roles)).
- **`HTTP 503` "Session revocation service unavailable" on logout or user
  changes**: the revocation service is unavailable; the local session is still
  cleared, retry later (see [OPERATIONS.md](OPERATIONS.md)).
- **Stale views**: tables and map poll automatically (map every ~30 s, logs
  every 5 s with `Auto refresh`, dashboard scan progress live). `Refresh`
  buttons force a reload; a hard browser refresh clears cached data.
- For server-side issues (containers, database, Celery, scheduler), see
  [OPERATIONS.md](OPERATIONS.md).
