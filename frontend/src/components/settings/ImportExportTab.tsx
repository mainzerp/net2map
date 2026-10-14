import { useState } from "react";
import { extractErrorMessage } from "../../api";
import { useExportConfig, useImportConfig } from "../../hooks/api";
import { useToast } from "../ToastProvider";
import { Button, Card } from "../ui";
import { SectionHeader } from "./shared";

function DataImportExportTabContent() {
  const [configDryRun, setConfigDryRun] = useState<boolean>(true);
  const [configData, setConfigData] = useState<string>("");
  const [configMsg, setConfigMsg] = useState<string>("");
  const { addToast } = useToast();

  const exportMutation = useExportConfig({
    onSuccess: (res) => {
      setConfigData(res?.data || "");
      setConfigMsg("Global config exported");
    },
    onError: (ex) => setConfigMsg(extractErrorMessage(ex)),
  });

  const importMutation = useImportConfig({
    onSuccess: (res, values) => {
      const errorCount = Array.isArray(res?.errors) ? res.errors.length : 0;
      const summary = `${values.dryRun ? "Dry-run" : "Restore"}: settings ${res?.totals?.settings ?? 0}, profiles ${res?.totals?.profiles ?? 0}, credentials ${res?.totals?.credentials ?? 0}, errors ${errorCount}`;
      setConfigMsg(summary);
      addToast(summary, errorCount > 0 ? "warning" : "success");
      if (errorCount > 0) {
        const details = res.errors!.map((e) => `${e.section} row ${e.row}: ${e.message}`).join("\n");
        setConfigData((prev) => `${prev}\n\n# Validation Errors\n${details}`);
      }
    },
    onError: (ex) => {
      const msg = extractErrorMessage(ex);
      setConfigMsg(msg);
      addToast(msg, "error");
    },
  });

  const busy = exportMutation.isPending || importMutation.isPending;

  return (
    <div className="flex-1 overflow-y-auto pt-5 flex flex-col gap-3.5">
      <Card title={<SectionHeader>GLOBAL BACKUP & RESTORE</SectionHeader>}>
        <div className="flex gap-2 items-center mb-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-muted text-[11px] cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-accent"
              checked={configDryRun}
              onChange={(e) => setConfigDryRun(e.target.checked)}
            />
            Dry-run restore
          </label>
          <Button onClick={() => { setConfigMsg(""); exportMutation.mutate(); }} disabled={busy}>
            Export Config
          </Button>
          <Button
            onClick={() => { setConfigMsg(""); importMutation.mutate({ data: configData, dryRun: configDryRun }); }}
            disabled={busy || !configData.trim()}
          >
            Import Config
          </Button>
          {configMsg && <span className="text-muted text-[10px]">{configMsg}</span>}
        </div>
        <textarea
          value={configData}
          onChange={(e) => setConfigData(e.target.value)}
          placeholder='{"version":1,"settings":[...],"profiles":[...],"credentials":[...]}'
          className="w-full min-h-[140px] px-2.5 py-2 rounded-control bg-surface text-primary text-xs border border-line-strong outline-none transition-colors placeholder:text-muted focus:border-accent focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-accent"
        />
      </Card>
    </div>
  );
}

export default DataImportExportTabContent;
