import { useState, useEffect } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import SnmpProfilesTabContent from "../components/settings/SnmpProfilesTab";
import CredentialsTabContent  from "../components/settings/CredentialsTab";
import RacksTabContent        from "../components/settings/RacksTab";
import ClassesTabContent      from "../components/settings/SwitchClassesTab";
import ModelsTabContent       from "../components/settings/SwitchModelsTab";
import EngineTabContent       from "../components/settings/ScanSettingsTab";
import DnsSettingsTabContent  from "../components/settings/DnsTab";
import BuildingsFloorsTabContent from "../components/settings/BuildingsFloorsTab";
import DataImportExportTabContent from "../components/settings/ImportExportTab";

interface NavItem {
  tab: string;
  label: string;
  desc: string;
}

interface NavGroup {
  group: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    group: "CREDENTIALS",
    items: [
      { tab:"profiles", label:"Profiles",  desc:"Global SNMP profiles" },
    ],
  },
  {
    group: "INFRASTRUCTURE",
    items: [
      { tab:"credentials", label:"Network Devices", desc:"Credentials" },
      { tab:"racks",       label:"Racks",    desc:"Rack definitions" },
      { tab:"classes",     label:"Classes",  desc:"Device roles / classes" },
      { tab:"models",      label:"Models",   desc:"Device models & port layout" },
    ],
  },
  {
    group: "ENGINE",
    items: [
      { tab:"scan",     label:"Scan",      desc:"Network discovery" },
      { tab:"dns",      label:"DNS",       desc:"Reverse lookup servers" },
    ],
  },
  {
    group: "APPEARANCE",
    items: [
      { tab:"floors",   label:"Buildings & floors", desc:"Floors and floor plans for the map" },
    ],
  },
  {
    group: "BACKUP",
    items: [
      { tab:"import-export", label:"Backup & Restore", desc:"Global config export/import" },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items);
const VALID_TABS = new Set(ALL_NAV_ITEMS.map(n => n.tab));
const NEW_ENTRY_TABS = new Set(["credentials", "profiles", "racks", "classes", "models"]);

// ===== SettingsPage (main export) =================================================
// The page shell owns only navigation and the "+ New Entry" trigger; every tab
// fetches and mutates its own data through the hooks in src/hooks/api/.
export default function SettingsPage() {
  const { tab = "" } = useParams();
  const [newEntryTrigger, setNewEntryTrigger] = useState(0);

  useEffect(() => { setNewEntryTrigger(0); }, [tab]);

  // The former "Map" tab (global background) became "Buildings & floors".
  if (tab === "map") {
    return <Navigate to="/settings/floors" replace />;
  }

  if (!VALID_TABS.has(tab)) {
    return <Navigate to="/settings/credentials" replace />;
  }

  const activeMeta = ALL_NAV_ITEMS.find(n => n.tab === tab);

  return (
    <div className="flex h-full overflow-hidden bg-surface text-primary text-xs leading-normal">
      {/* Sidebar */}
      <div className="w-56 shrink-0 border-r border-line bg-surface py-6 px-3 flex flex-col gap-1 overflow-y-auto">
        <div className="text-muted text-[10px] tracking-[2px] mb-3 pl-2 select-none">
          SETTINGS
        </div>
        {NAV_GROUPS.map(({ group, items }, gi) => (
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
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col overflow-hidden bg-surface">
        <div className="pt-5 px-8 shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-primary font-bold text-lg">
                {activeMeta?.label}
              </div>
              <div className="text-muted text-xs mt-1">
                {activeMeta?.desc}
              </div>
            </div>
            {NEW_ENTRY_TABS.has(tab) && (
              <button
                onClick={() => setNewEntryTrigger(t => t + 1)}
                className="bg-panel-2 border border-line-strong text-accent rounded-control px-4 py-1.5 cursor-pointer text-[11px] font-semibold hover:border-accent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >+ New Entry</button>
            )}
          </div>
          <div className="h-px bg-line mt-3.5" />
        </div>

        <div className="flex-1 overflow-hidden flex w-full px-8 pb-5">
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
