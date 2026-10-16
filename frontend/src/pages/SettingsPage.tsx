import { useState, useEffect } from "react";
import { NavLink, Navigate, useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button, Select } from "../components/ui";
import SnmpProfilesTabContent from "../components/settings/SnmpProfilesTab";
import CredentialsTabContent  from "../components/settings/CredentialsTab";
import RacksTabContent        from "../components/settings/RacksTab";
import ClassesTabContent      from "../components/settings/SwitchClassesTab";
import ModelsTabContent       from "../components/settings/SwitchModelsTab";
import EngineTabContent       from "../components/settings/ScanSettingsTab";
import DnsSettingsTabContent  from "../components/settings/DnsTab";
import BuildingsFloorsTabContent from "../components/settings/BuildingsFloorsTab";
import DataImportExportTabContent from "../components/settings/ImportExportTab";

export interface SettingsNavItem {
  tab: string;
  label: string;
  desc: string;
}

export interface SettingsNavGroup {
  group: string;
  items: SettingsNavItem[];
}

// Groups follow the order a user sets things up: discover devices first, then
// describe the site and hardware, then system-wide tasks. Tab ids are part of
// the URL contract (/settings/<tab>) and must stay stable.
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    group: "DISCOVERY",
    items: [
      { tab:"credentials", label:"Network Devices", desc:"Devices to scan, credentials, candidates" },
      { tab:"profiles",    label:"SNMP Profiles",   desc:"Reusable SNMP credentials" },
      { tab:"scan",        label:"Scan",            desc:"Schedules, ranges, history" },
      { tab:"dns",         label:"DNS",             desc:"Reverse lookup servers" },
    ],
  },
  {
    group: "SITE & HARDWARE",
    items: [
      { tab:"floors",  label:"Buildings & Floors", desc:"Locations and floor plans" },
      { tab:"racks",   label:"Racks",              desc:"Racks and their location" },
      { tab:"classes", label:"Device Classes",     desc:"Roles: color, map visibility" },
      { tab:"models",  label:"Hardware Models",    desc:"Port layout templates" },
    ],
  },
  {
    group: "SYSTEM",
    items: [
      { tab:"import-export", label:"Backup & Restore", desc:"Export / import configuration" },
    ],
  },
];

const ALL_NAV_ITEMS = SETTINGS_NAV_GROUPS.flatMap(g => g.items);
const VALID_TABS = new Set(ALL_NAV_ITEMS.map(n => n.tab));
const DEFAULT_TAB = "credentials";

// Tabs with a create dialog; the label names what the button creates.
const NEW_ENTRY_LABELS: Record<string, string> = {
  credentials: "New device",
  profiles:    "New profile",
  racks:       "New rack",
  classes:     "New class",
  models:      "New model",
};

// One-sentence concept explanations for tabs whose purpose is not obvious.
const TAB_ABOUT: Record<string, string> = {
  floors:  "Buildings contain floors; each floor is one map view. Create floors first, then put racks and devices on them.",
  racks:   "A rack is a physical cabinet on a floor. Define it here, then place devices at U positions on the Racks page.",
  classes: "A class is your own role label (e.g. Core, Access). It colors devices on the map and decides whether unracked devices are shown.",
  models:  "A hardware model is a port layout template (ports per row, visible ports) for faceplates. It is separate from the model string the device reports via SNMP.",
};

// ===== SettingsPage (main export) =================================================
// The page shell owns only navigation and the per-tab "New ..." trigger; every
// tab fetches and mutates its own data through the hooks in src/hooks/api/.
// Below the md breakpoint the sidebar collapses into a native select.
export default function SettingsPage() {
  const { tab = "" } = useParams();
  const navigate = useNavigate();
  const [newEntryTrigger, setNewEntryTrigger] = useState(0);

  useEffect(() => { setNewEntryTrigger(0); }, [tab]);

  // The former "Map" tab (global background) became "Buildings & floors".
  if (tab === "map") {
    return <Navigate to="/settings/floors" replace />;
  }

  if (!VALID_TABS.has(tab)) {
    return <Navigate to={`/settings/${DEFAULT_TAB}`} replace />;
  }

  const activeMeta = ALL_NAV_ITEMS.find(n => n.tab === tab);
  const newEntryLabel = NEW_ENTRY_LABELS[tab];
  const about = TAB_ABOUT[tab];

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden bg-surface text-primary text-xs leading-normal">
      {/* Mobile navigation */}
      <div className="md:hidden shrink-0 border-b border-line bg-surface px-4 py-3">
        <label htmlFor="settings-section-select" className="block text-muted text-[10px] tracking-[2px] mb-1.5 select-none">
          SETTINGS
        </label>
        <Select
          id="settings-section-select"
          value={tab}
          onChange={e => navigate(`/settings/${e.target.value}`)}
        >
          {SETTINGS_NAV_GROUPS.map(({ group, items }) => (
            <optgroup key={group} label={group}>
              {items.map(({ tab: itemTab, label }) => (
                <option key={itemTab} value={itemTab}>{label}</option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>

      {/* Sidebar */}
      <nav
        aria-label="Settings sections"
        className="hidden md:flex w-56 shrink-0 border-r border-line bg-surface py-6 px-3 flex-col gap-1 overflow-y-auto"
      >
        <div className="text-muted text-[10px] tracking-[2px] mb-3 pl-2 select-none">
          SETTINGS
        </div>
        {SETTINGS_NAV_GROUPS.map(({ group, items }, gi) => (
          <div key={group}>
            {gi > 0 && <div className="h-px bg-line mx-2 my-2" />}
            <div className="text-muted text-[10px] tracking-[2px] px-2 pt-1.5 pb-1 select-none">
              {group}
            </div>
            {items.map(({ tab: itemTab, label, desc }) => (
              <NavLink
                key={itemTab}
                to={`/settings/${itemTab}`}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2.5 rounded-control w-full text-left no-underline border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    isActive
                      ? "bg-panel-2 border-line-strong"
                      : "bg-transparent border-transparent hover:bg-panel-2"
                  }`
                }
              >
                {({ isActive }) => (
                  <div>
                    <div className={`text-xs font-semibold ${isActive ? "text-accent" : "text-muted"}`}>
                      {label}
                    </div>
                    <div className={`text-[10px] mt-px ${isActive ? "text-accent" : "text-muted opacity-70"}`}>
                      {desc}
                    </div>
                  </div>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Content area */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-surface">
        <div className="pt-5 px-4 md:px-8 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-primary font-bold text-lg m-0">
                {activeMeta?.label}
              </h1>
              <div className="text-muted text-xs mt-1">
                {activeMeta?.desc}
              </div>
              {about && (
                <p className="text-muted text-[11px] mt-1.5 mb-0 max-w-3xl">
                  {about}
                </p>
              )}
            </div>
            {newEntryLabel && (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => setNewEntryTrigger(t => t + 1)}
              >
                <Plus size={14} aria-hidden="true" />
                {newEntryLabel}
              </Button>
            )}
          </div>
          <div className="h-px bg-line mt-3.5" />
        </div>

        <div className="flex-1 min-h-0 overflow-hidden flex w-full px-4 md:px-8 pb-5">
          {tab === "credentials" && <CredentialsTabContent newEntryTrigger={newEntryTrigger} />}
          {tab === "profiles" && <SnmpProfilesTabContent newEntryTrigger={newEntryTrigger} />}
          {tab === "import-export" && <DataImportExportTabContent />}
          {tab === "racks"    && <RacksTabContent newEntryTrigger={newEntryTrigger} />}
          {tab === "classes"  && <ClassesTabContent newEntryTrigger={newEntryTrigger} />}
          {tab === "models"   && <ModelsTabContent newEntryTrigger={newEntryTrigger} />}
          {tab === "scan"     && <EngineTabContent />}
          {tab === "dns"      && <DnsSettingsTabContent />}
          {tab === "floors"   && <BuildingsFloorsTabContent />}
        </div>
      </div>
    </div>
  );
}
