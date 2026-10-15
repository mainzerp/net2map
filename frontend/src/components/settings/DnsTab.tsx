import { useState, useEffect, useRef } from "react";
import { extractErrorMessage } from "../../api";
import { useDnsServers, useTestDns, useUpdateDnsServers } from "../../hooks/api";
import { Button, Card, Input } from "../ui";
import { SectionHeader, TabLoading } from "./shared";

// ── DnsSettingsTabContent ───────────────────────────────────────────────────
function DnsSettingsTabContent() {
  const { data: servers = [], isLoading } = useDnsServers();
  const [serversText, setServersText] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [ok, setOk] = useState<string>("");

  // Hydrate the textarea once when the saved server list first arrives;
  // later refetches must not clobber unsaved edits.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (isLoading || hydratedRef.current) return;
    hydratedRef.current = true;
    setServersText(servers.join("\n"));
  }, [isLoading, servers]);

  const saveMutation = useUpdateDnsServers({
    onSuccess: (normalized) => {
      setServersText(normalized.join("\n"));
      setOk("DNS settings saved");
    },
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const save = () => {
    setErr("");
    setOk("");
    const list = serversText
      .split(/[\n,;]/)
      .map((v) => v.trim())
      .filter(Boolean);
    saveMutation.mutate(list);
  };

  return (
    <div className="flex-1 overflow-y-auto pt-5 flex flex-col gap-5">
      <Card title={<SectionHeader>DNS RESOLVER</SectionHeader>}>
        <div className="text-muted text-[11px] leading-relaxed mb-3">
          DNS servers for reverse lookups (PTR) of endpoint and device names during scans.
          Leave empty to use the resolver of the backend container. Docker&apos;s built-in
          resolver usually cannot answer PTR queries for local addresses, so enter the DNS
          server that knows your local names (e.g. the router or firewall running DHCP).
        </div>
        {isLoading ? (
          <TabLoading />
        ) : (
          <div className="flex flex-col gap-3">
            <textarea
              value={serversText}
              onChange={(e) => setServersText(e.target.value)}
              placeholder={"One DNS server IP per line, e.g.\n10.0.0.10\n1.1.1.1"}
              className="w-full min-h-[140px] resize-y px-2.5 py-2 rounded-control bg-panel-2 text-primary text-xs border border-line-strong outline-none transition-colors placeholder:text-muted focus:border-accent focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-accent"
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
      <DnsTestCard />
    </div>
  );
}

// ── DnsTestCard ─────────────────────────────────────────────────────────────
// Reverse-resolves one IP with the saved servers and the container resolver
// (no cache) and shows each answer or error.
function DnsTestCard() {
  const [ip, setIp] = useState("");
  const [err, setErr] = useState("");
  const testMutation = useTestDns({ onError: (ex) => setErr(extractErrorMessage(ex)) });
  const result = testMutation.data;

  const run = () => {
    setErr("");
    if (ip.trim()) testMutation.mutate(ip.trim());
  };

  return (
    <Card title={<SectionHeader>TEST REVERSE LOOKUP</SectionHeader>}>
      <div className="text-muted text-[11px] leading-relaxed mb-3">
        Resolve one IP address with the saved DNS servers and the container resolver, without cache.
      </div>
      <div className="flex gap-2 items-center">
        <Input
          aria-label="IP address to resolve"
          value={ip}
          placeholder="e.g. 10.0.0.25"
          onChange={(e) => setIp(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          className="max-w-56"
        />
        <Button variant="secondary" onClick={run} disabled={!ip.trim() || testMutation.isPending}>
          {testMutation.isPending ? "Resolving..." : "Resolve"}
        </Button>
      </div>
      {err && <div className="mt-2 text-[11px] text-danger">{err}</div>}
      {result && (
        <ul className="mt-3 flex flex-col gap-1.5 text-[11px]" data-testid="dns-test-results">
          {result.results.map((r) => (
            <li key={r.resolver} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold text-primary w-28 shrink-0">
                {r.resolver === "custom" ? "DNS servers" : "Container resolver"}
              </span>
              <span className="font-mono text-muted">{r.nameservers.join(", ") || "-"}</span>
              {r.host ? (
                <span className="font-mono text-success">{r.host}</span>
              ) : (
                <span className="text-danger">{r.error || "no name"}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default DnsSettingsTabContent;
