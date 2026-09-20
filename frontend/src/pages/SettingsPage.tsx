import { useState, useEffect, useRef } from "react";
import { api, API, _getAuthHeader } from "../api";
import { debounce } from "../utils/debounce";
import type { SnmpProfile } from "../types";
import SnmpProfilesTabContent from "../components/settings/SnmpProfilesTab";
import CredentialsTabContent  from "../components/settings/CredentialsTab";
import RacksTabContent        from "../components/settings/RacksTab";
import ClassesTabContent      from "../components/settings/SwitchClassesTab";
import ModelsTabContent       from "../components/settings/SwitchModelsTab";
import EngineTabContent       from "../components/settings/ScanSettingsTab";
import DnsSettingsTabContent  from "../components/settings/DnsTab";
import MapSettingsTabContent  from "../components/settings/MapSettingsTab";
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

// ===== SettingsPage (main export) =================================================
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("switches");
  const [profiles, setProfiles]   = useState<SnmpProfile[]>([]);
  const [profLoading, setProfLoading] = useState(true);
  const [newEntryTrigger, setNewEntryTrigger] = useState(0);

  // Map background state
  const [mapBgUrl, setMapBgUrl]   = useState<string | null>(null);
  const [mapBgOpacity, setMapBgOpacity] = useState(0.3);
  const [mapBgScale, setMapBgScale] = useState(1);
  const [mapBgColor, setMapBgColor] = useState("#020817");
  const bgFileRef = useRef<HTMLInputElement>(null);
  const [mapBgError, setMapBgError] = useState("");
  const [mapSettingsError, setMapSettingsError] = useState("");
  const [mapSettingsLoading, setMapSettingsLoading] = useState(true);
  const [profError, setProfError] = useState("");

  useEffect(() => { setNewEntryTrigger(0); }, [activeTab]);

  const refreshProfiles = () => {
    setProfLoading(true);
    setProfError("");
    api.get("/api/snmp-profiles")
      .then((d: SnmpProfile[]) => { setProfiles(d); setProfLoading(false); })
      .catch((ex: unknown) => { setProfError(ex instanceof Error ? ex.message : String(ex)); setProfLoading(false); });
  };
  useEffect(() => { refreshProfiles(); }, []);

  // Load map background
  useEffect(() => {
    fetch(`${API}/api/map-background`)
      .then(r => { if (r.ok) setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`); })
      .catch((ex: unknown) => { setMapBgError(ex instanceof Error ? ex.message : "Failed to load map background"); });
    api.get("/api/map-settings").then((s: Record<string, unknown>) => {
      if (s.opacity != null) setMapBgOpacity(s.opacity as number);
      if (s.scale != null) setMapBgScale(s.scale as number);
      if (s.bg_color != null) setMapBgColor(s.bg_color as string);
    }).catch((ex: unknown) => {
      setMapSettingsError(ex instanceof Error ? ex.message : "Failed to load map settings");
    }).finally(() => setMapSettingsLoading(false));
  }, []);

  const uploadMapBg = async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API}/api/map-background`, {
      method: "POST",
      body: fd,
      headers: _getAuthHeader(),
    });
    if (!res.ok) {
      let msg: string;
      try { const b = await res.json(); msg = b?.error?.message || b?.detail || res.statusText; } catch { msg = res.statusText; }
      alert(`Upload failed: ${msg}`);
      return;
    }
    setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`);
  };

  const removeMapBg = async () => {
    await api.del("/api/map-background");
    setMapBgUrl(null);
  };

  // Debounced saver: sliders and the color picker fire per tick, so coalesce
  // them into one PUT after the user pauses.
  const saveMapSettings = useRef(
    debounce((patch: Record<string, unknown>) => {
      api.put("/api/map-settings", patch).catch((ex: unknown) => {
        setMapSettingsError(ex instanceof Error ? ex.message : "Failed to save map settings");
      });
    }, 300)
  ).current;

  const changeBgOpacity = (val: number) => {
    setMapBgOpacity(val);
    setMapSettingsError("");
    saveMapSettings({ opacity: val });
  };

  const changeBgScale = (val: number) => {
    setMapBgScale(val);
    setMapSettingsError("");
    saveMapSettings({ scale: val });
  };

  const changeBgColor = (val: string) => {
    setMapBgColor(val);
    setMapSettingsError("");
    saveMapSettings({ bg_color: val });
  };

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
        { tab:"switches", label:"Switches",  desc:"Credentials" },
        { tab:"racks",    label:"Racks",     desc:"Rack definitions" },
        { tab:"classes",  label:"Classes",   desc:"Device roles / classes" },
        { tab:"models",   label:"Models",    desc:"Switch models & port layout" },
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
        { tab:"map",      label:"Map",       desc:"Background image settings" },
      ],
    },
    {
      group: "BACKUP",
      items: [
        { tab:"data",     label:"Backup & Restore", desc:"Global config export/import" },
      ],
    },
  ];

  const allNavItems = NAV_GROUPS.flatMap(g => g.items);

  return (
    <div style={{
      display:"flex", height:"calc(100vh - 48px)", overflow:"hidden",
      backgroundColor:"#020817", fontFamily:"'Inter', system-ui, sans-serif",
      color:"#e2e8f0", fontSize:12, lineHeight:1.4,
    }}>
      {/* Sidebar */}
      <div style={{
        width:220, borderRight:"1px solid #0f172a", flexShrink:0,
        backgroundColor:"#020817", padding:"24px 12px",
        display:"flex", flexDirection:"column", gap:4,
      }}>
        <div style={{color:"#64748b",fontSize:10,letterSpacing:2,marginBottom:12,paddingLeft:8}}>
          SETTINGS
        </div>
        {NAV_GROUPS.map(({ group, items }, gi) => (
          <div key={group}>
            {gi > 0 && <div style={{height:1,backgroundColor:"#0f172a",margin:"8px 8px"}}/>}
            <div style={{color:"#64748b",fontSize:10,letterSpacing:2,padding:"6px 8px 4px",userSelect:"none"}}>
              {group}
            </div>
            {items.map(({ tab, label, desc }) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              display:"flex", alignItems:"center", gap:10,
              padding:"10px 12px", borderRadius:8, cursor:"pointer",
              border:"none", textAlign:"left", width:"100%",
              backgroundColor: activeTab===tab ? "#083344" : "transparent",
              outline: activeTab===tab ? "1px solid #164e63" : "1px solid transparent",
              transition:"all 0.15s",
            }}
          >
            <div>
              <div style={{fontSize:12, fontWeight:600, color: activeTab===tab ? "#22d3ee" : "#94a3b8", fontFamily:"inherit"}}>
                {label}
              </div>
              <div style={{fontSize:10, color: activeTab===tab ? "#7dd3fc" : "#64748b", marginTop:1, fontFamily:"inherit"}}>
                {desc}
              </div>
            </div>
          </button>
            ))}
          </div>
        ))}
      </div>

      {/* Content area */}
      <div style={{
        flex:1, display:"flex", flexDirection:"column", overflow:"hidden",
        backgroundColor:"#020917",
      }}>
        <div style={{padding:"20px 32px 0",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{color:"#e2e8f0",fontWeight:700,fontSize:18}}>
                {allNavItems.find(n=>n.tab===activeTab)?.label}
              </div>
              <div style={{color:"#64748b",fontSize:12,marginTop:3}}>
                {allNavItems.find(n=>n.tab===activeTab)?.desc}
              </div>
            </div>
            {["switches","profiles","racks","classes","models"].includes(activeTab) && (
              <button
                onClick={() => setNewEntryTrigger(t => t + 1)}
                style={{
                  backgroundColor:"#083344", border:"1px solid #164e63", color:"#22d3ee",
                  borderRadius:6, padding:"7px 16px", cursor:"pointer",
                  fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600,
                }}
              >+ New Entry</button>
            )}
          </div>
          <div style={{height:1,backgroundColor:"#0f172a",marginTop:14}}/>
        </div>

        <div style={{flex:1, overflow:"hidden", display:"flex", width:"100%", padding:"0 32px 20px"}}>
          {activeTab === "switches" && <CredentialsTabContent profiles={profiles} newEntryTrigger={newEntryTrigger} />}
          {activeTab === "profiles" && <SnmpProfilesTabContent profiles={profiles} loading={profLoading} onChanged={refreshProfiles} newEntryTrigger={newEntryTrigger} loadError={profError} />}
          {activeTab === "data"     && <DataImportExportTabContent onProfilesChanged={refreshProfiles} />}
          {activeTab === "racks"    && <RacksTabContent newEntryTrigger={newEntryTrigger} />}
          {activeTab === "classes"  && <ClassesTabContent newEntryTrigger={newEntryTrigger} />}
          {activeTab === "models"   && <ModelsTabContent newEntryTrigger={newEntryTrigger} />}
          {activeTab === "scan"     && <EngineTabContent />}
          {activeTab === "dns"      && <DnsSettingsTabContent />}
          {activeTab === "map"      && (
            <MapSettingsTabContent
              url={mapBgUrl}
              opacity={mapBgOpacity}
              scale={mapBgScale}
              bgColor={mapBgColor}
              fileRef={bgFileRef}
              onUpload={uploadMapBg}
              onRemove={removeMapBg}
              onChangeOpacity={changeBgOpacity}
              onChangeScale={changeBgScale}
              onChangeBgColor={changeBgColor}
              loading={mapSettingsLoading}
              error={mapBgError || mapSettingsError}
            />
          )}
        </div>
      </div>
    </div>
  );
}
