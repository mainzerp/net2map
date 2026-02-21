# Switch-Map - Open Items

## UI / Frontend

- [x] **Class badge on rack detail panel** -- Show the assigned class name and color indicator on each switch in the rack side panel
- [x] **Class color on topology map nodes** -- Color-code switch nodes on the topology map by their class (Top of Rack = cyan, Access = green, Aggregation = amber, Core = purple)
- [x] **Rack / class filter on topology map** -- Add filter controls to show or hide devices by class or rack
- [x] **Settings: device overview tab** -- Add a "Devices" tab in settings showing all discovered devices with inline rack and class assignment columns

## Backend / Data

- [x] **Rack grouping via rack_id FK** -- Use the managed `rack_id` foreign key instead of (or alongside) the `location` string for rack grouping in the topology view
- [x] **Profile ID on seeded credentials** -- Assign `profile_id` to the seeded credentials so they correctly reference the global SNMP profiles
