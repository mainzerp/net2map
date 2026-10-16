import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { extractErrorMessage, AUTH_PROTOCOLS, PRIV_PROTOCOLS, SEC_LEVELS } from "../../api";
import { deviceDisplayName, matchesQuery } from "../../utils/deviceSearch";
import type { Credential, TopologyNode } from "../../types";
import {
  useCredentials,
  useDeleteCredential,
  useDevices,
  useRacks,
  useSaveCredential,
  useSnmpProfiles,
  useUpdateDeviceMeta,
} from "../../hooks/api";
import { Badge, Button, Card, EmptyState, Input, Modal, Select, StatusDot } from "../ui";
import { ConfirmDeleteModal, Field, SectionHeader, TabLoading } from "./shared";
import { normalizeEngineId, validateEngineId } from "./engineId";
import { formatRelativeTime, formatTimestamp } from "../../utils/datetime";
import PingCandidatesSection from "./PingCandidatesSection";

// ── Local interfaces ────────────────────────────────────────────────────────
interface CredentialForm {
  label: string;
  ip: string;
  priority: number;
  snmp_port: number;
  enabled: boolean;
  /** False = ping only: no SNMP polling, SNMP fields are ignored. */
  snmp_enabled: boolean;
  profile_id: number | null;
  device_id: number | null;
  snmp_version: string;
  community: string;
  v3_security_level: string;
  v3_username: string;
  v3_auth_protocol: string;
  v3_auth_password: string;
  v3_priv_protocol: string;
  v3_priv_password: string;
  v3_engine_id: string;
}

interface EditState {
  id: number | null;
  open: boolean;
}

interface CredentialsTabContentProps {
  newEntryTrigger: number;
}

// ── CredentialsTabContent ────────────────────────────────────────────────────
const EMPTY_FORM: CredentialForm = {
  label: "", ip: "", priority: 0, snmp_port: 161, enabled: true,
  snmp_enabled: true,
  profile_id: null,
  device_id: null,
  snmp_version: "v2c", community: "public",
  v3_security_level: "authPriv", v3_username: "",
  v3_auth_protocol: "SHA-256", v3_auth_password: "",
  v3_priv_protocol: "AES-128", v3_priv_password: "",
  v3_engine_id: "",
};

function CredentialsTabContent({ newEntryTrigger }: CredentialsTabContentProps) {
  const { data: creds = [], isLoading } = useCredentials();
  const { data: devicesRaw } = useDevices();
  const { data: racks = [] } = useRacks();
  const { data: profiles = [] } = useSnmpProfiles();

  const devices: TopologyNode[] = Array.isArray(devicesRaw)
    ? devicesRaw
    : ((devicesRaw as { nodes?: TopologyNode[] } | undefined)?.nodes ?? []);

  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm] = useState<CredentialForm>({ ...EMPTY_FORM });
  const [err, setErr] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<Credential | null>(null);
  const [togglingIgnoreId, setTogglingIgnoreId] = useState<number | null>(null);
  // Display name lives on the discovered device, not on the credential.
  const [displayName, setDisplayName] = useState("");
  const [displayTarget, setDisplayTarget] = useState<{ id: number; initial: string } | null>(null);
  // Search over all three lists, kept in ?q= like the other list pages.
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const setQuery = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value);
    else next.delete("q");
    setSearchParams(next, { replace: true });
  };

  // Open the new-entry form whenever the parent increments the trigger
  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const resetForm = () => {
    setForm({ ...EMPTY_FORM });
    setEditState({ id: null, open: false });
    setErr("");
    setDisplayName("");
    setDisplayTarget(null);
  };

  const prepareDisplayName = (device: TopologyNode | undefined) => {
    setDisplayName(device?.display_name ?? "");
    setDisplayTarget(device ? { id: device.id, initial: device.display_name ?? "" } : null);
  };

  const startNew = () => {
    setForm({ ...EMPTY_FORM });
    setEditState({ id: null, open: true });
    setErr("");
    prepareDisplayName(undefined);
  };

  const startEdit = (c: Credential) => {
    // The API masks secrets as "***"; map them to "" so a submit never writes
    // the mask back over the real stored password/community.
    const unmask = (v: string) => (v === "***" ? "" : v);
    setForm({
      label: c.label, ip: c.ip, priority: c.priority ?? 0, snmp_port: c.snmp_port, enabled: c.enabled,
      snmp_enabled: c.snmp_enabled !== false,
      profile_id: c.profile_id ?? null,
      device_id: c.device_id ?? null,
      snmp_version: c.snmp_version, community: unmask(c.community),
      v3_security_level: c.v3_security_level, v3_username: c.v3_username,
      v3_auth_protocol: c.v3_auth_protocol, v3_auth_password: unmask(c.v3_auth_password),
      v3_priv_protocol: c.v3_priv_protocol, v3_priv_password: unmask(c.v3_priv_password),
      v3_engine_id: c.v3_engine_id ?? "",
    });
    setEditState({ id: c.id, open: true });
    setErr("");
    prepareDisplayName(devices.find((d) => (c.device_id ? d.id === c.device_id : d.ip === c.ip)));
  };

  const toggleIgnoreMutation = useUpdateDeviceMeta({
    onMutate: ({ id }) => setTogglingIgnoreId(Number(id)),
    onSettled: () => setTogglingIgnoreId(null),
  });

  // On edit, the hook omits secret fields left empty so the backend keeps
  // the stored value instead of overwriting it.
  const saveMutation = useSaveCredential({
    onSuccess: () => resetForm(),
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });
  const displayNameMutation = useUpdateDeviceMeta();

  const deleteMutation = useDeleteCredential({
    onSuccess: () => setDeleteTarget(null),
  });

  const F = form;
  const set = <K extends keyof CredentialForm>(k: K, v: CredentialForm[K]) => setForm((p) => ({ ...p, [k]: v }));
  const pingOnly = !F.snmp_enabled;
  const isV3 = !pingOnly && F.snmp_version === "v3";
  const needAuth = isV3 && F.v3_security_level !== "noAuthNoPriv";
  const needPriv = isV3 && F.v3_security_level === "authPriv";
  // Engine ID override applies to v3 only; with a profile the profile's version decides.
  const selectedProfile = F.profile_id != null ? profiles.find((p) => p.id === F.profile_id) : null;
  const effectiveV3 = pingOnly
    ? false
    : F.profile_id != null ? selectedProfile?.snmp_version === "v3" : isV3;
  const engineIdError = effectiveV3 ? validateEngineId(F.v3_engine_id) : "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (engineIdError) return;
    // The display name is saved on the device first; the credential save
    // closes the dialog.
    const nextDisplayName = displayName.trim();
    if (displayTarget && nextDisplayName !== displayTarget.initial) {
      try {
        await displayNameMutation.mutateAsync({ id: displayTarget.id, patch: { display_name: nextDisplayName } });
      } catch (ex) {
        setErr(extractErrorMessage(ex));
        return;
      }
    }
    // Engine IDs are only meaningful for v3; an empty override means discovery.
    const engineId = effectiveV3 ? normalizeEngineId(F.v3_engine_id) : "";
    saveMutation.mutate({ id: editState.id, form: { ...form, v3_engine_id: engineId } });
  };

  // Credentials with their discovered device, rack and profile, filtered by
  // label, IP, profile, SNMP user, device names, vendor/model and rack.
  const visibleCreds = [...creds]
    .sort((a, b) => (a.label || "").localeCompare(b.label || ""))
    .map((c) => {
      const matchedDevice = devices.find((d) => d.ip === c.ip);
      const assignedRack = matchedDevice?.rack_id ? racks.find((r) => r.id === matchedDevice.rack_id) : null;
      const assignedProfile = c.profile_id ? profiles.find((p) => p.id === c.profile_id) : null;
      return { c, matchedDevice, assignedRack, assignedProfile };
    })
    .filter(({ c, matchedDevice, assignedRack, assignedProfile }) =>
      matchesQuery(query, [
        c.label, c.ip, c.snmp_version, c.v3_username, c.snmp_enabled === false ? "ping only" : "",
        assignedProfile?.label, matchedDevice?.display_name, matchedDevice?.sys_name, matchedDevice?.hostname, matchedDevice?.vendor,
        matchedDevice?.model, assignedRack?.label, assignedRack?.room,
      ]),
    );

  const ignoreButton = (d: TopologyNode) => (
    <Button
      size="sm"
      disabled={togglingIgnoreId === d.id}
      onClick={() => toggleIgnoreMutation.mutate({ id: d.id, patch: { ignored: !d.ignored } })}
      title={d.ignored ? "Re-enable: scan this device and show on map" : "Ignore: skip scan and hide from map"}
      className={d.ignored ? "border-accent text-accent" : ""}
    >
      {togglingIgnoreId === d.id ? "..." : d.ignored ? "Re-enable" : "Ignore"}
    </Button>
  );

  return (
    <div className="flex-1 overflow-y-auto pt-5">
      {/* New / edit credential dialog */}
      <Modal open={editState.open} onClose={resetForm} title={editState.id ? "Edit device" : "New device"} width={560}>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Label *">
                <Input required value={F.label} onChange={(e) => set("label", e.target.value)} placeholder="Core Router RZ-01" />
              </Field>
              <Field label="IP address *">
                <Input required value={F.ip} onChange={(e) => set("ip", e.target.value)} placeholder="192.168.1.1" />
              </Field>
              <div className="col-span-2">
                <Field label="Display name (optional)">
                  <Input
                    value={displayName}
                    maxLength={120}
                    disabled={!displayTarget}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={displayTarget ? F.label || "Shown instead of the label" : "Available after the first scan"}
                  />
                  <span className="block mt-1 text-[10px] text-muted leading-relaxed">
                    Shown everywhere on the map, in racks and lists. Empty: the label is shown.
                  </span>
                </Field>
              </div>
              <Field label="Priority (0 = primary)">
                <Input type="number" min="0" value={F.priority} onChange={(e) => set("priority", +e.target.value)} />
              </Field>
              {!pingOnly && (
                <Field label="SNMP Port">
                  <Input type="number" value={F.snmp_port} onChange={(e) => set("snmp_port", +e.target.value)} />
                </Field>
              )}
            </div>
            <label className="flex items-start gap-1.5 text-[11px] text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-accent mt-0.5"
                checked={pingOnly}
                onChange={(e) => set("snmp_enabled", !e.target.checked)}
              />
              <span>
                <span className="text-primary">Ping only (no SNMP)</span>
                <span className="block text-[10px]">
                  Monitor reachability and latency only, for devices without SNMP (printers, cameras, APs, ...).
                </span>
              </span>
            </label>
            {!pingOnly && (
              <Field label="Credential profile (optional)">
                <Select
                  value={F.profile_id ?? ""}
                  onChange={(e) => set("profile_id", e.target.value ? +e.target.value : null)}
                >
                  <option value="">-- No profile (manual settings) --</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} - {p.snmp_version === "v3" ? `v3 / ${p.v3_security_level}` : `v2c / ${p.community}`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {!pingOnly && F.profile_id == null && (
              <>
                <div>
                  <div className="text-[10px] text-muted mb-1 select-none">SNMP Version</div>
                  <div className="flex gap-1.5">
                    {["v2c", "v3"].map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => set("snmp_version", v)}
                        className={`px-3.5 py-1 rounded text-[11px] cursor-pointer border transition-colors ${
                          F.snmp_version === v
                            ? "font-semibold bg-panel-2 border-accent text-accent"
                            : "bg-transparent border-line-strong text-muted hover:text-primary"
                        }`}
                      >{v}</button>
                    ))}
                  </div>
                </div>
                {!isV3 && (
                  <Field label={`Community String *${editState.id ? " (leave empty to keep)" : ""}`}>
                    <Input
                      required={!editState.id}
                      value={F.community}
                      onChange={(e) => set("community", e.target.value)}
                      placeholder={editState.id ? "unchanged" : "public"}
                    />
                  </Field>
                )}
                {isV3 && (
                  <div className="p-3 rounded-card bg-panel-2 border border-line-strong flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Username *">
                        <Input required={isV3} value={F.v3_username} onChange={(e) => set("v3_username", e.target.value)} placeholder="netmonitor" />
                      </Field>
                      <Field label="Security Level">
                        <Select value={F.v3_security_level} onChange={(e) => set("v3_security_level", e.target.value)}>
                          {SEC_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                        </Select>
                      </Field>
                    </div>
                    {needAuth && (
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Auth protocol">
                          <Select value={F.v3_auth_protocol} onChange={(e) => set("v3_auth_protocol", e.target.value)}>
                            {AUTH_PROTOCOLS.map((p) => <option key={p}>{p}</option>)}
                          </Select>
                        </Field>
                        <Field label={`Auth password *${editState.id ? " (leave empty to keep)" : ""}`}>
                          <Input
                            required={needAuth && !editState.id}
                            type="password"
                            value={F.v3_auth_password}
                            onChange={(e) => set("v3_auth_password", e.target.value)}
                            placeholder={editState.id ? "unchanged" : ">= 8 characters"}
                          />
                        </Field>
                      </div>
                    )}
                    {needPriv && (
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Priv protocol (encryption)">
                          <Select value={F.v3_priv_protocol} onChange={(e) => set("v3_priv_protocol", e.target.value)}>
                            {PRIV_PROTOCOLS.map((p) => <option key={p}>{p}</option>)}
                          </Select>
                        </Field>
                        <Field label={`Priv password *${editState.id ? " (leave empty to keep)" : ""}`}>
                          <Input
                            required={needPriv && !editState.id}
                            type="password"
                            value={F.v3_priv_password}
                            onChange={(e) => set("v3_priv_password", e.target.value)}
                            placeholder={editState.id ? "unchanged" : ">= 8 characters"}
                          />
                        </Field>
                      </div>
                    )}
                    <div className="text-[10px] text-muted leading-relaxed">
                      {F.v3_security_level === "noAuthNoPriv" && "Warning: No auth / no encryption - for testing only"}
                      {F.v3_security_level === "authNoPriv" && "Warning: Authentication without encryption"}
                      {F.v3_security_level === "authPriv" && "OK: Authentication + encryption (recommended)"}
                    </div>
                  </div>
                )}
              </>
            )}
            {effectiveV3 && (
              <Field label="Engine ID override (optional)" error={engineIdError || undefined}>
                <Input
                  value={F.v3_engine_id}
                  invalid={!!engineIdError}
                  onChange={(e) => set("v3_engine_id", e.target.value)}
                  placeholder="e.g. 80000b8503001122334455"
                  className="font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="block mt-1 text-[10px] text-muted leading-relaxed">
                  Leave empty to use automatic discovery. Discovery still runs; an override only fixes the
                  engine ID the keys are localized to, for agents that expect a specific one.
                </span>
              </Field>
            )}
            <label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer select-none">
              <input type="checkbox" className="accent-accent" checked={F.enabled} onChange={(e) => set("enabled", e.target.checked)} />
              Include in scan
            </label>
            {err && <div className="text-[11px] text-danger">{err}</div>}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" className="flex-1" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : editState.id ? "Save changes" : "+ Add"}
              </Button>
              <Button type="button" onClick={resetForm}>Cancel</Button>
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmDeleteModal
        open={deleteTarget != null}
        title="Delete Credentials"
        message={deleteTarget ? `Delete credentials "${deleteTarget.label}" (${deleteTarget.ip})? This cannot be undone.` : ""}
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search network devices..."
          aria-label="Search network devices"
          className="max-w-xs"
        />
        {query && (
          <span className="text-[10px] text-muted" data-testid="credential-search-count">
            {visibleCreds.length} of {creds.length} entries
          </span>
        )}
      </div>

      {isLoading ? (
        <TabLoading />
      ) : creds.length === 0 ? (
        <EmptyState title="No entries yet" hint="Add a device to scan with the New device button above." />
      ) : visibleCreds.length === 0 ? (
        <EmptyState title="No entries match your search" className="mb-5" />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2 mb-5">
          {visibleCreds.map(({ c, matchedDevice, assignedRack, assignedProfile }) => {
            const pingOnly = c.snmp_enabled === false;
            const v3 = !pingOnly && c.snmp_version === "v3";
            return (
              <Card key={c.id} className={c.enabled ? "" : "opacity-50"}>
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <StatusDot status={c.enabled ? "up" : "unknown"} />
                      <span className="text-primary font-semibold text-xs truncate" data-testid="credential-name">
                        {matchedDevice?.display_name || c.label}
                      </span>
                      {pingOnly ? (
                        <Badge tone="warning" title="Ping only: no SNMP polling">Ping only</Badge>
                      ) : (
                        <Badge tone={v3 ? "accent" : "neutral"}>{c.snmp_version}</Badge>
                      )}
                      {assignedRack ? (
                        <Badge tone="accent" title={`Rack: ${assignedRack.label}${assignedRack.room ? ` / ${assignedRack.room}` : ""}`}>
                          {assignedRack.label}{assignedRack.room ? ` / ${assignedRack.room}` : ""}
                        </Badge>
                      ) : (
                        <Badge tone="neutral" title="No rack assigned">no rack</Badge>
                      )}
                      {matchedDevice && <Badge tone="success">discovered</Badge>}
                      {matchedDevice?.ignored && <Badge tone="danger">ignored</Badge>}
                    </div>
                    {matchedDevice?.display_name && matchedDevice.display_name !== c.label && (
                      <div className="text-muted text-[10px] mt-0.5 pl-3.5 truncate">Label: {c.label}</div>
                    )}
                    <div className="text-muted text-[10px] mt-1 pl-3.5">
                      {pingOnly ? c.ip : <>{c.ip}:{c.snmp_port}</>}
                      {pingOnly
                        ? null
                        : assignedProfile
                        ? <> - <span className="text-accent">{assignedProfile.label}</span></>
                        : !v3
                          ? <> - {c.community}</>
                          : <> - {c.v3_username}</>}
                    </div>
                    {(c.discovered_engine_id || c.v3_engine_id) && (
                      <div className="text-[10px] mt-0.5 pl-3.5 flex items-baseline gap-1 flex-wrap min-w-0">
                        <span className="text-muted">Engine ID</span>
                        {c.discovered_engine_id ? (
                          <>
                            <span className="font-mono text-primary break-all" data-testid="engine-id">
                              {c.discovered_engine_id}
                            </span>
                            {c.engine_id_seen_at && (
                              <span className="text-muted" title={formatTimestamp(c.engine_id_seen_at)}>
                                seen {formatRelativeTime(c.engine_id_seen_at)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted">not yet discovered</span>
                        )}
                        {c.v3_engine_id && (
                          <Badge
                            tone={c.discovered_engine_id && c.discovered_engine_id !== c.v3_engine_id ? "warning" : "neutral"}
                            title={`Manual override: ${c.v3_engine_id}`}
                          >override</Badge>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-1.5 justify-end">
                  {matchedDevice && ignoreButton(matchedDevice)}
                  <Button size="sm" onClick={() => startEdit(c)}>Edit</Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleteTarget(c)}>Delete</Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {(() => {
        const credIps = new Set(creds.map((c) => c.ip));
        const unassigned = devices.filter(
          (d) => !credIps.has(d.ip) && matchesQuery(query, [d.sys_name, d.hostname, d.ip, d.vendor, d.model]),
        );
        if (unassigned.length === 0) return null;
        return (
          <div className="mt-1">
            <SectionHeader>DISCOVERED WITHOUT CREDENTIALS ({unassigned.length})</SectionHeader>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2 mt-2.5">
              {[...unassigned].sort((a, b) => deviceDisplayName(a).localeCompare(deviceDisplayName(b))).map((d) => (
                <Card key={d.id}>
                  <div className="mb-1.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <StatusDot status="unknown" className="bg-warning" />
                      <span className="text-primary font-semibold text-xs truncate">{deviceDisplayName(d)}</span>
                      <Badge tone="warning">unassigned</Badge>
                      {d.ignored && <Badge tone="danger">ignored</Badge>}
                    </div>
                    <div className="text-primary text-[10px] mt-1 pl-3.5">
                      {d.ip}
                      {d.vendor && <> - {d.vendor}</>}
                      {d.model && <> - {d.model}</>}
                      {d.ports && <> - {d.ports.filter((p) => p.oper_status === 1).length}/{d.ports.length} ports</>}
                    </div>
                  </div>
                  <div className="flex gap-1.5 justify-end">
                    {ignoreButton(d)}
                    <Button
                      size="sm"
                      className="border-warning text-warning"
                      onClick={() => {
                        setForm((f) => ({ ...f, label: d.sys_name || d.ip, ip: d.ip, device_id: d.id }));
                        setEditState({ id: null, open: true });
                        setErr("");
                        prepareDisplayName(d);
                      }}
                    >+ Add credentials</Button>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        );
      })()}
      <PingCandidatesSection search={query} />
    </div>
  );
}

export default CredentialsTabContent;
