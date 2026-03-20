import { useState } from "react";
import { api, extractErrorMessage } from "../../api";
import { useToast } from "../ToastProvider";

interface ImportExportProps {
  onProfilesChanged?: () => void;
}

interface ImportTotals {
  settings?: number;
  profiles?: number;
  credentials?: number;
}

interface ImportError {
  section: string;
  row: number;
  message: string;
}

interface ImportResponse {
  totals?: ImportTotals;
  errors?: ImportError[];
}

function DataImportExportTabContent({ onProfilesChanged }: ImportExportProps) {
  const [configDryRun, setConfigDryRun] = useState<boolean>(true);
  const [configData, setConfigData] = useState<string>("");
  const [configBusy, setConfigBusy] = useState<boolean>(false);
  const [configMsg, setConfigMsg] = useState<string>("");
  const { addToast } = useToast();

  const exportConfig = async () => {
    setConfigBusy(true);
    setConfigMsg("");
    try {
      const res: { data?: string } = await api.get("/api/config/export");
      setConfigData(res?.data || "");
      setConfigMsg("Global config exported");
    } catch (ex) {
      setConfigMsg(extractErrorMessage(ex));
    } finally {
      setConfigBusy(false);
    }
  };

  const importConfig = async () => {
    setConfigBusy(true);
    setConfigMsg("");
    try {
      const res: ImportResponse = await api.post("/api/config/import", {
        data: configData,
        dry_run: configDryRun,
      });
      const errorCount = Array.isArray(res?.errors) ? res.errors.length : 0;
      const summary = `${configDryRun ? "Dry-run" : "Restore"}: settings ${res?.totals?.settings ?? 0}, profiles ${res?.totals?.profiles ?? 0}, credentials ${res?.totals?.credentials ?? 0}, errors ${errorCount}`;
      setConfigMsg(summary);
      addToast(summary, errorCount > 0 ? "warning" : "success");
      if (!configDryRun) onProfilesChanged?.();
      if (errorCount > 0) {
        const details = res.errors!.map(e => `${e.section} row ${e.row}: ${e.message}`).join("\n");
        setConfigData(prev => `${prev}\n\n# Validation Errors\n${details}`);
      }
    } catch (ex) {
      const msg = String(ex);
      setConfigMsg(msg);
      addToast(msg, "error");
    } finally {
      setConfigBusy(false);
    }
  };


  return (
    <div style={{flex:1,overflowY:"auto",paddingTop:20,display:"flex",flexDirection:"column",gap:14}}>
      <div style={{backgroundColor:"#0a0e18",border:"1px solid #1e293b",borderRadius:10,padding:"12px"}}>
        <div style={{color:"#94a3b8",fontSize:10,letterSpacing:1,marginBottom:8}}>GLOBAL BACKUP & RESTORE</div>
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
          <label style={{display:"flex",alignItems:"center",gap:6,color:"#94a3b8",fontSize:11}}>
            <input type="checkbox" checked={configDryRun} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigDryRun(e.target.checked)} /> Dry-run restore
          </label>
          <button type="button" onClick={exportConfig} disabled={configBusy} style={{background:"none",border:"1px solid #1e293b",color:"#94a3b8",borderRadius:5,padding:"5px 10px",cursor:"pointer",fontSize:11}}>Export Config</button>
          <button type="button" onClick={importConfig} disabled={configBusy || !configData.trim()} style={{background:"none",border:"1px solid #1e293b",color:"#94a3b8",borderRadius:5,padding:"5px 10px",cursor:"pointer",fontSize:11}}>Import Config</button>
          {configMsg && <span style={{color:"#64748b",fontSize:10}}>{configMsg}</span>}
        </div>
        <textarea
          value={configData}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setConfigData(e.target.value)}
          placeholder='{"version":1,"settings":[...],"profiles":[...],"credentials":[...]}'
          style={{width:"100%",minHeight:140,backgroundColor:"#020817",border:"1px solid #1e293b",borderRadius:6,color:"#e2e8f0",padding:"8px",fontFamily:"'Inter', system-ui, sans-serif",fontSize:11,boxSizing:"border-box"}}
        />
      </div>
    </div>
  );
}

export default DataImportExportTabContent;
