import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, extractErrorMessage, AUTH_PROTOCOLS, PRIV_PROTOCOLS, SEC_LEVELS } from "../../api";
import type { SnmpProfile } from "../../types";
import { queryKeys, useInvalidateApi, useSnmpProfiles } from "../../hooks/api";
import { Badge, Button, Card, EmptyState, Input, Modal, Select } from "../ui";
import { ConfirmDeleteModal, Field, TabError, TabLoading } from "./shared";

// ── SnmpProfilesTabContent ──────────────────────────────────────────────────
interface ProfileForm {
  label: string;
  snmp_version: string;
  community: string;
  v3_security_level: string;
  v3_username: string;
  v3_auth_protocol: string;
  v3_auth_password: string;
  v3_priv_protocol: string;
  v3_priv_password: string;
}

interface EditState {
  id: number | null;
  open: boolean;
}

interface SnmpProfilesTabContentProps {
  newEntryTrigger: number;
}

const EMPTY_PROFILE_FORM: ProfileForm = {
  label: "",
  snmp_version: "v2c", community: "public",
  v3_security_level: "authPriv", v3_username: "",
  v3_auth_protocol: "SHA-256", v3_auth_password: "",
  v3_priv_protocol: "AES-128", v3_priv_password: "",
};

function SnmpProfilesTabContent({ newEntryTrigger }: SnmpProfilesTabContentProps) {
  const { data: profiles = [], isLoading, error: loadError } = useSnmpProfiles();
  const { invalidate } = useInvalidateApi();
  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm] = useState<ProfileForm>({ ...EMPTY_PROFILE_FORM });
  const [err, setErr] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<SnmpProfile | null>(null);

  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const resetForm = () => { setForm({ ...EMPTY_PROFILE_FORM }); setEditState({ id: null, open: false }); setErr(""); };
  const startNew = () => { setForm({ ...EMPTY_PROFILE_FORM }); setEditState({ id: null, open: true }); setErr(""); };
  const startEdit = (p: SnmpProfile) => {
    // The API masks secrets as "***"; map them to "" so a submit never writes
    // the mask back over the real stored password/community.
    const unmask = (v: string) => (v === "***" ? "" : v);
    setEditState({ id: p.id, open: true });
    setForm({
      label: p.label, snmp_version: p.snmp_version, community: unmask(p.community),
      v3_security_level: p.v3_security_level, v3_username: p.v3_username,
      v3_auth_protocol: p.v3_auth_protocol, v3_auth_password: unmask(p.v3_auth_password),
      v3_priv_protocol: p.v3_priv_protocol, v3_priv_password: unmask(p.v3_priv_password),
    });
    setErr("");
  };

  const saveMutation = useMutation({
    mutationFn: async (values: { id: number | null; form: ProfileForm }) => {
      if (values.id) {
        // On edit, omit secret fields left empty so the backend keeps the
        // stored value instead of overwriting it.
        const payload: Record<string, unknown> = { ...values.form };
        (["community", "v3_auth_password", "v3_priv_password"] as const).forEach((k) => {
          if (payload[k] === "") delete payload[k];
        });
        await api.put(`/api/snmp-profiles/${values.id}`, payload);
      } else {
        await api.post("/api/snmp-profiles", values.form);
      }
    },
    onSuccess: () => {
      invalidate(queryKeys.snmpProfiles);
      resetForm();
    },
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.del(`/api/snmp-profiles/${id}`),
    onSuccess: () => {
      invalidate(queryKeys.snmpProfiles);
      setDeleteTarget(null);
    },
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr("");
    saveMutation.mutate({ id: editState.id, form });
  };

  const F = form;
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => setForm((p) => ({ ...p, [k]: v }));
  const isV3 = F.snmp_version === "v3";
  const needAuth = isV3 && F.v3_security_level !== "noAuthNoPriv";
  const needPriv = isV3 && F.v3_security_level === "authPriv";

  return (
    <div className="flex-1 overflow-y-auto pt-5">
      {/* New / edit profile dialog */}
      <Modal open={editState.open} onClose={resetForm} title={editState.id ? "Edit Profile" : "New Profile"} width={480}>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <Field label="Profile name *">
              <Input required value={F.label} onChange={(e) => set("label", e.target.value)} placeholder="SNMPv3 Aruba Core" />
            </Field>
            <div>
              <div className="text-[10px] text-muted mb-1 select-none">SNMP Version</div>
              <div className="flex gap-1.5">
                {(["v2c", "v3"] as const).map((v) => (
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
                {F.community === "public" && (
                  <span className="block mt-1 text-[11px] text-warning">
                    Warning: &quot;public&quot; is the factory-default community string and may allow unauthorised SNMP access.
                  </span>
                )}
              </Field>
            )}
            {isV3 && (
              <div className="p-3 rounded-lg bg-panel-2 border border-line-strong flex flex-col gap-3">
                <Field label="Security Level">
                  <Select value={F.v3_security_level} onChange={(e) => set("v3_security_level", e.target.value)}>
                    {SEC_LEVELS.map((l) => <option key={l}>{l}</option>)}
                  </Select>
                </Field>
                <Field label="Username">
                  <Input value={F.v3_username} onChange={(e) => set("v3_username", e.target.value)} />
                </Field>
                {needAuth && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Auth Protocol">
                      <Select value={F.v3_auth_protocol} onChange={(e) => set("v3_auth_protocol", e.target.value)}>
                        {AUTH_PROTOCOLS.map((p) => <option key={p}>{p}</option>)}
                      </Select>
                    </Field>
                    <Field label="Auth Password">
                      <Input type="password" value={F.v3_auth_password} onChange={(e) => set("v3_auth_password", e.target.value)} />
                    </Field>
                  </div>
                )}
                {needPriv && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Priv Protocol">
                      <Select value={F.v3_priv_protocol} onChange={(e) => set("v3_priv_protocol", e.target.value)}>
                        {PRIV_PROTOCOLS.map((p) => <option key={p}>{p}</option>)}
                      </Select>
                    </Field>
                    <Field label="Priv Password">
                      <Input type="password" value={F.v3_priv_password} onChange={(e) => set("v3_priv_password", e.target.value)} />
                    </Field>
                  </div>
                )}
              </div>
            )}
            {err && <div className="text-[11px] text-danger">{err}</div>}
            <div className="flex gap-2 mt-1">
              <Button type="submit" variant="primary" className="flex-1" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : editState.id ? "Save" : "Create profile"}
              </Button>
              <Button type="button" onClick={resetForm}>Cancel</Button>
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmDeleteModal
        open={deleteTarget != null}
        title="Delete Profile"
        message={deleteTarget ? `Delete profile "${deleteTarget.label}"? This cannot be undone.` : ""}
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Card grid listing */}
      {loadError && <TabError message={extractErrorMessage(loadError)} />}
      {isLoading ? (
        <TabLoading />
      ) : profiles.length === 0 ? (
        <EmptyState title="No profiles defined yet" hint="Create a profile with + New Entry above." />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
          {profiles.map((p) => {
            const isV3Card = p.snmp_version === "v3";
            return (
              <Card key={p.id} className={`border-l-2 ${isV3Card ? "border-l-accent-strong" : "border-l-accent"}`}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-primary font-semibold text-[13px] truncate">{p.label}</span>
                      <Badge tone={isV3Card ? "accent" : "neutral"}>{p.snmp_version}</Badge>
                    </div>
                    <div className="text-muted text-[10px] mt-1">
                      {isV3Card ? `${p.v3_security_level} - ${p.v3_username || "-"}` : `Community: ${p.community}`}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button size="sm" onClick={() => startEdit(p)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleteTarget(p)}>Delete</Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default SnmpProfilesTabContent;
