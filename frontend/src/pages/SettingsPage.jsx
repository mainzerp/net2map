import { useState, useEffect, useRef } from "react";
import { api, API } from "../api.js";
import SnmpProfilesTabContent from "../components/settings/SnmpProfilesTab.jsx";
import CredentialsTabContent  from "../components/settings/CredentialsTab.jsx";
import RacksTabContent        from "../components/settings/RacksTab.jsx";
import ClassesTabContent      from "../components/settings/SwitchClassesTab.jsx";
import ModelsTabContent       from "../components/settings/SwitchModelsTab.jsx";
import EngineTabContent       from "../components/settings/ScanSettingsTab.jsx";
import DnsSettingsTabContent  from "../components/settings/DnsTab.jsx";
import MapSettingsTabContent  from "../components/settings/MapSettingsTab.jsx";
import DataImportExportTabContent from "../components/settings/ImportExportTab.jsx";
// ===== SettingsPage (main export) =================================================
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("switches");
  const [profiles, setProfiles]   = useState([]);
  const [profLoading, setProfLoading] = useState(true);

  // Map background state
  const [mapBgUrl, setMapBgUrl]   = useState(null);
  const [mapBgOpacity, setMapBgOpacity] = useState(0.3);
  const [mapBgScale, setMapBgScale] = useState(1);
  const bgFileRef = useRef(null);

  const refreshProfiles = () => {
    setProfLoading(true);
    api.get("/api/snmp-profiles").then(d => { setProfiles(d); setProfLoading(false); }).catch(() => setProfLoading(false));
  };
  useEffect(() => { refreshProfiles(); }, []);

  // Load map background
  useEffect(() => {
    fetch(`${API}/api/map-background`, { method: "GET" })
      .then(r => { if (r.ok) setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`); })
      .catch(() => {});
    api.get("/api/map-settings").then(s => {
      if (s.opacity != null) setMapBgOpacity(s.opacity);
      if (s.scale != null) setMapBgScale(s.scale);
    }).catch(() => {});
  }, []);

  const uploadMapBg = async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    await fetch(`${API}/api/map-background`, { method: "POST", body: fd });
    setMapBgUrl(`${API}/api/map-background?v=${Date.now()}`);
  };

  const removeMapBg = async () => {
    await fetch(`${API}/api/map-background`, { method: "DELETE" });
    setMapBgUrl(null);
  };

  const changeBgOpacity = (val) => {
    setMapBgOpacity(val);
    api.put("/api/map-settings", { opacity: val }).catch(console.error);
  };

  const changeBgScale = (val) => {
    setMapBgScale(val);
    api.put("/api/map-settings", { scale: val }).catch(console.error);
  };

  const NAV_GROUPS = [
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
          <div style={{color:"#e2e8f0",fontWeight:700,fontSize:18}}>
            {allNavItems.find(n=>n.tab===activeTab)?.label}
          </div>
          <div style={{color:"#64748b",fontSize:12,marginTop:3}}>
            {allNavItems.find(n=>n.tab===activeTab)?.desc}
          </div>
          <div style={{height:1,backgroundColor:"#0f172a",marginTop:14}}/>
        </div>

        <div style={{flex:1, overflow:"hidden", display:"flex", maxWidth:900, width:"100%", padding:"0 32px 20px"}}>
          {activeTab === "switches" && <CredentialsTabContent profiles={profiles} />}
          {activeTab === "profiles" && <SnmpProfilesTabContent profiles={profiles} loading={profLoading} onChanged={refreshProfiles} />}
          {activeTab === "data"     && <DataImportExportTabContent onProfilesChanged={refreshProfiles} />}
          {activeTab === "racks"    && <RacksTabContent />}
          {activeTab === "classes"  && <ClassesTabContent />}
          {activeTab === "models"   && <ModelsTabContent />}
          {activeTab === "scan"     && <EngineTabContent />}
          {activeTab === "dns"      && <DnsSettingsTabContent />}
          {activeTab === "map"      && (
            <MapSettingsTabContent
              url={mapBgUrl}
              opacity={mapBgOpacity}
              scale={mapBgScale}
              fileRef={bgFileRef}
              onUpload={uploadMapBg}
              onRemove={removeMapBg}
              onChangeOpacity={changeBgOpacity}
              onChangeScale={changeBgScale}
            />
          )}
        </div>
      </div>
    </div>
  );
}

