import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, extractErrorMessage } from "../../api";
import type { SwitchModel, TopologyNode } from "../../types";
import { queryKeys, useDevices, useInvalidateApi, useSwitchModels } from "../../hooks/api";
import { Badge, Button, Card, EmptyState, Input, Modal } from "../ui";
import { ConfirmDeleteModal, DeviceAssignment, Field, TabLoading } from "./shared";

// ── ModelsTabContent ────────────────────────────────────────────────────────
interface ModelForm {
  name: string;
  ports_per_row: number | string;
  total_ports: number | string;
  description: string;
}

interface EditState {
  id: number | null;
  open: boolean;
}

interface ModelsTabContentProps {
  newEntryTrigger: number;
}

const EMPTY_MODEL_FORM: ModelForm = { name: "", ports_per_row: 24, total_ports: "", description: "" };

function ModelsTabContent({ newEntryTrigger }: ModelsTabContentProps) {
  const { data: models = [], isLoading } = useSwitchModels();
  const { data: devicesRaw } = useDevices();
  const { invalidate } = useInvalidateApi();

  const devices: TopologyNode[] = Array.isArray(devicesRaw) ? devicesRaw : [];

  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm] = useState<ModelForm>({ ...EMPTY_MODEL_FORM });
  const [cutoffEnabled, setCutoffEnabled] = useState<boolean>(false);
  const [err, setErr] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<SwitchModel | null>(null);

  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const resetForm = () => { setForm({ ...EMPTY_MODEL_FORM }); setCutoffEnabled(false); setEditState({ id: null, open: false }); setErr(""); };
  const startNew = () => { setForm({ ...EMPTY_MODEL_FORM }); setCutoffEnabled(false); setEditState({ id: null, open: true }); setErr(""); };
  const startEdit = (sm: SwitchModel) => {
    setEditState({ id: sm.id, open: true });
    setForm({
      name: sm.name,
      ports_per_row: sm.ports_per_row,
      total_ports: sm.total_ports ?? "",
      description: (sm as SwitchModel & { description?: string }).description ?? "",
    });
    setCutoffEnabled(sm.total_ports != null);
    setErr("");
  };

  const saveMutation = useMutation({
    mutationFn: async (values: { id: number | null; form: ModelForm; cutoff: boolean }) => {
      const ppr = parseInt(String(values.form.ports_per_row), 10);
      if (!String(values.form.name).trim()) throw new Error("Name is required");
      if (isNaN(ppr) || ppr < 1) throw new Error("Ports per row must be a positive number");
      const payload = {
        name: String(values.form.name).trim(),
        ports_per_row: ppr,
        total_ports: values.cutoff && values.form.total_ports !== "" ? parseInt(String(values.form.total_ports), 10) || null : null,
        description: values.form.description,
      };
      if (values.id) {
        await api.put(`/api/switch-models/${values.id}`, payload);
      } else {
        const r = await api.post<{ detail?: unknown }>("/api/switch-models", payload);
        if (r.detail) throw new Error(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail));
      }
    },
    onSuccess: () => {
      invalidate(queryKeys.switchModels, queryKeys.topology, queryKeys.devices);
      resetForm();
    },
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.del(`/api/switch-models/${id}`),
    onSuccess: () => {
      invalidate(queryKeys.switchModels, queryKeys.topology, queryKeys.devices);
      setDeleteTarget(null);
    },
  });

  const assignMutation = useMutation({
    mutationFn: ({ devId, modelId }: { devId: string; modelId: number | null }) =>
      api.patch(`/api/topology/devices/${devId}/meta`, { model_id: modelId }),
    onSuccess: () => {
      invalidate(queryKeys.topology, queryKeys.devices, queryKeys.credentials);
    },
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr("");
    saveMutation.mutate({ id: editState.id, form, cutoff: cutoffEnabled });
  };

  return (
    <div className="flex-1 overflow-y-auto pt-5">
      {/* New / edit model dialog */}
      <Modal open={editState.open} onClose={resetForm} title={editState.id ? "Edit Model" : "New Model"} width={520}>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[2fr_1fr] gap-2">
              <Field label="Name">
                <Input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Aruba CX 6300M-48" />
              </Field>
              <Field label="Ports per row">
                <Input type="number" min="1" max="96" value={form.ports_per_row} onChange={(e) => setForm((f) => ({ ...f, ports_per_row: e.target.value }))} />
              </Field>
            </div>
            <div>
              <div
                className="text-[10px] text-muted select-none mb-1"
                title="Ports beyond this count (sorted by index) are hidden. Use to suppress aggregation or uplink ports that appear as regular ports on some devices."
              >Total ports (cutoff)</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={cutoffEnabled}
                  onClick={() => { setCutoffEnabled((v) => !v); if (cutoffEnabled) setForm((f) => ({ ...f, total_ports: "" })); }}
                  className={`w-8 h-[18px] rounded-full cursor-pointer shrink-0 relative border transition-colors ${
                    cutoffEnabled ? "bg-accent-strong border-accent" : "bg-panel-2 border-line-strong"
                  }`}
                >
                  <span
                    className={`absolute top-[2px] w-3 h-3 rounded-full transition-all ${
                      cutoffEnabled ? "left-[14px] bg-accent" : "left-[2px] bg-muted"
                    }`}
                  />
                </button>
                {cutoffEnabled ? (
                  <Input
                    type="number"
                    min="1"
                    className="flex-1"
                    value={form.total_ports}
                    onChange={(e) => setForm((f) => ({ ...f, total_ports: e.target.value }))}
                    placeholder="e.g. 48"
                    autoFocus
                  />
                ) : (
                  <span className="text-muted text-[10px]">disabled</span>
                )}
              </div>
            </div>
            <Field label="Description">
              <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="optional" />
            </Field>
            {err && <div className="text-[11px] text-danger">{err}</div>}
            <div className="flex gap-2 mt-1">
              <Button type="submit" variant="primary" className="flex-1" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : editState.id ? "Save" : "Create model"}
              </Button>
              <Button type="button" onClick={resetForm}>Cancel</Button>
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmDeleteModal
        open={deleteTarget != null}
        title="Delete Model"
        message={deleteTarget ? `Delete model "${deleteTarget.name}"? Assigned devices are unassigned, not deleted.` : ""}
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Card grid listing */}
      {isLoading ? (
        <TabLoading />
      ) : models.length === 0 ? (
        <EmptyState title="No models defined yet" hint="Create a model with + New Entry above." />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
          {models.map((sm) => {
            const assigned = devices.filter((d) => d.model_id === sm.id);
            const available = devices.filter((d) => d.model_id == null && !d.ignored);
            return (
              <Card key={sm.id} className="border-l-2 border-l-accent">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-primary font-semibold text-[13px] truncate">{sm.name}</span>
                      <Badge tone="accent">{sm.ports_per_row} ports/row</Badge>
                      {sm.total_ports != null && (
                        <span className="text-muted text-[10px]">{sm.total_ports} total</span>
                      )}
                    </div>
                    {(sm as SwitchModel & { description?: string }).description && (
                      <div className="text-muted text-[10px] mt-0.5">{(sm as SwitchModel & { description?: string }).description}</div>
                    )}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button size="sm" onClick={() => startEdit(sm)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleteTarget(sm)}>Delete</Button>
                  </div>
                </div>
                <DeviceAssignment
                  assigned={assigned}
                  available={available}
                  onAssign={(devId) => assignMutation.mutate({ devId: String(devId), modelId: sm.id })}
                  onUnassign={(devId) => assignMutation.mutate({ devId: String(devId), modelId: null })}
                />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ModelsTabContent;
