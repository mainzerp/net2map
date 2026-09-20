import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, extractErrorMessage } from "../../api";
import { queryKeys, useDnsServers, useInvalidateApi } from "../../hooks/api";
import { Button, Card } from "../ui";
import { SectionHeader, TabLoading } from "./shared";

// ── DnsSettingsTabContent ───────────────────────────────────────────────────
function DnsSettingsTabContent() {
  const { data: servers = [], isLoading } = useDnsServers();
  const { invalidate } = useInvalidateApi();
  const [serversText, setServersText] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [ok, setOk] = useState<string>("");

  // Sync the textarea once the saved server list arrives.
  useEffect(() => {
    if (!isLoading) setServersText(servers.join("\n"));
  }, [isLoading, servers]);

  const saveMutation = useMutation({
    mutationFn: async (text: string) => {
      const list = text
        .split(/[\n,;]/)
        .map((v) => v.trim())
        .filter(Boolean);
      const result: { servers?: string[] } = await api.put("/api/dns-settings", { servers: list });
      return Array.isArray(result?.servers) ? result.servers : list;
    },
    onSuccess: (normalized) => {
      setServersText(normalized.join("\n"));
      setOk("DNS settings saved");
      invalidate(queryKeys.dnsSettings);
    },
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const save = () => {
    setErr("");
    setOk("");
    saveMutation.mutate(serversText);
  };

  return (
    <div className="flex-1 overflow-y-auto pt-5 flex flex-col gap-5">
      <Card title={<SectionHeader>DNS RESOLVER</SectionHeader>}>
        <div className="text-muted text-[11px] leading-relaxed mb-3">
          Configure DNS servers for reverse lookup of peer hostnames during scans.
          Leave empty to use system/default DNS resolver.
        </div>
        {isLoading ? (
          <TabLoading />
        ) : (
          <div className="flex flex-col gap-3">
            <textarea
              value={serversText}
              onChange={(e) => setServersText(e.target.value)}
              placeholder={"One DNS server IP per line, e.g.\n10.0.0.10\n1.1.1.1"}
              className="w-full min-h-[140px] resize-y px-2.5 py-2 rounded-md bg-panel-2 text-primary text-xs border border-line-strong outline-none transition-colors placeholder:text-muted focus:border-accent"
            />
            <div className="text-muted text-[10px]">
              Accepted formats: IPv4 and IPv6. You can also separate values by comma.
            </div>
            {err && <div className="text-[11px] text-danger">{err}</div>}
            {ok && <div className="text-[11px] text-success">{ok}</div>}
            <div className="flex gap-2">
              <Button variant="primary" onClick={save} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : "Save DNS Settings"}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export default DnsSettingsTabContent;
