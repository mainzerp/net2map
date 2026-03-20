import { useState, useEffect } from "react";
import { api, extractErrorMessage } from "../../api";

// ── DnsSettingsTabContent ───────────────────────────────────────────────────
function DnsSettingsTabContent() {
  const [serversText, setServersText] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [err, setErr] = useState<string>("");
  const [ok, setOk] = useState<string>("");

  useEffect(() => {
    api.get("/api/dns-settings")
      .then((data: { servers?: string[] }) => {
        const servers = Array.isArray(data?.servers) ? data.servers : [];
        setServersText(servers.join("\n"));
      })
      .catch(() => setErr("Failed to load DNS settings"))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setErr("");
    setOk("");
    try {
      const servers = serversText
        .split(/[\n,;]/)
        .map(v => v.trim())
        .filter(Boolean);

      const result: { servers?: string[] } = await api.put("/api/dns-settings", { servers });
      const normalized = Array.isArray(result?.servers) ? result.servers : servers;
      setServersText(normalized.join("\n"));
      setOk("DNS settings saved");
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const boxStyle: React.CSSProperties = {
    backgroundColor: "#0a0e18", border: "1px solid #1e293b", borderRadius: 10,
    padding: 20, display: "flex", flexDirection: "column", gap: 12,
  };

  const textareaStyle: React.CSSProperties = {
    backgroundColor:"#0c0f18", border:"1px solid #1e293b", borderRadius:6,
    color:"#e2e8f0", padding:"8px 10px", minHeight:140, resize:"vertical",
    fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, width:"100%",
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", paddingTop: 20, display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={boxStyle}>
        <div style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: 2 }}>DNS RESOLVER</div>
        <div style={{ color: "#475569", fontSize: 11, lineHeight: 1.6 }}>
          Configure DNS servers for reverse lookup of peer hostnames during scans.
          Leave empty to use system/default DNS resolver.
        </div>

        {loading ? (
          <div style={{ color:"#334155", fontSize:11 }}>Loading...</div>
        ) : (
          <>
            <textarea
              value={serversText}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setServersText(e.target.value)}
              placeholder={"One DNS server IP per line, e.g.\n10.0.0.10\n1.1.1.1"}
              style={textareaStyle}
            />
            <div style={{ color:"#334155", fontSize:10 }}>
              Accepted formats: IPv4 and IPv6. You can also separate values by comma.
            </div>
            {err && <div style={{ color:"#f87171", fontSize:11 }}>{err}</div>}
            {ok && <div style={{ color:"#4ade80", fontSize:11 }}>{ok}</div>}
            <div style={{ display:"flex", gap:8 }}>
              <button
                onClick={save}
                disabled={saving}
                style={{
                  border:"1px solid #164e63", background:"#083344", color:"#22d3ee",
                  borderRadius:6, padding:"8px 16px", cursor:saving ? "wait" : "pointer",
                  fontFamily:"'Inter', system-ui, sans-serif", fontSize:11, fontWeight:600,
                  opacity:saving ? 0.7 : 1,
                }}
              >{saving ? "Saving..." : "Save DNS Settings"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default DnsSettingsTabContent;
