import { useState, useEffect } from "react";
import { extractErrorMessage } from "../../api";
import type { SwitchClass, TopologyNode } from "../../types";
import {
  useDeleteSwitchClass,
  useDevices,
  useSaveSwitchClass,
  useSwitchClasses,
  useUpdateDeviceMeta,
} from "../../hooks/api";
import { DEFAULT_SWITCH_CLASS_COLOR } from "../../theme/visual";
import { Badge, Button, Card, EmptyState, Input, Modal } from "../ui";
import { ConfirmDeleteModal, DeviceAssignment, Field, TabError, TabLoading } from "./shared";

// ── ClassesTabContent ────────────────────────────────────────────────────────
interface ClassForm {
  label: string;
  description: string;
  color: string;
  allow_outside_rack: boolean;
}

interface EditState {
  id: number | null;
  open: boolean;
}

interface ClassesTabContentProps {
  newEntryTrigger: number;
}

// Default for a user-chosen class color (data, not UI chrome): the palette ink
// blue from theme/visual.ts. A native color input needs a hex value.
const EMPTY_CLASS_FORM: ClassForm = { label: "", description: "", color: DEFAULT_SWITCH_CLASS_COLOR, allow_outside_rack: false };

function ClassesTabContent({ newEntryTrigger }: ClassesTabContentProps) {
  const { data: classes = [], isLoading } = useSwitchClasses();
  const { data: devicesRaw } = useDevices();

  const devices: TopologyNode[] = Array.isArray(devicesRaw) ? devicesRaw : [];

  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm] = useState<ClassForm>({ ...EMPTY_CLASS_FORM });
  const [err, setErr] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<SwitchClass | null>(null);

  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const resetForm = () => { setForm({ ...EMPTY_CLASS_FORM }); setEditState({ id: null, open: false }); setErr(""); };
  const startNew = () => { setForm({ ...EMPTY_CLASS_FORM }); setEditState({ id: null, open: true }); setErr(""); };
  const startEdit = (sc: SwitchClass) => {
    setEditState({ id: sc.id, open: true });
    setForm({ label: sc.label, description: sc.description ?? "", color: sc.color, allow_outside_rack: !!sc.allow_outside_rack });
    setErr("");
  };

  const saveMutation = useSaveSwitchClass({
    onSuccess: () => resetForm(),
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const deleteMutation = useDeleteSwitchClass({
    onSuccess: () => setDeleteTarget(null),
  });

  const assignMutation = useUpdateDeviceMeta({
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr("");
    if (!form.label.trim()) { setErr("Label is required"); return; }
    saveMutation.mutate({ id: editState.id, form });
  };

  return (
    <div className="flex-1 overflow-y-auto pt-5">
      {/* New / edit class dialog */}
      <Modal open={editState.open} onClose={resetForm} title={editState.id ? "Edit Class" : "New Class"} width={480}>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
              <Field label="Label">
                <Input required value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Top of Rack" />
              </Field>
              <Field label="Color">
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                  className="w-10 h-[29px] p-0.5 bg-panel-2 border border-line-strong rounded cursor-pointer"
                />
              </Field>
            </div>
            <Field label="Description">
              <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="optional" />
            </Field>
            <label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-accent"
                checked={!!form.allow_outside_rack}
                onChange={(e) => setForm((f) => ({ ...f, allow_outside_rack: e.target.checked }))}
              />
              Allow outside rack placement
            </label>
            {err && <div className="text-[11px] text-danger">{err}</div>}
            <div className="flex gap-2 mt-1">
              <Button type="submit" variant="primary" className="flex-1" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : editState.id ? "Save" : "Create class"}
              </Button>
              <Button type="button" onClick={resetForm}>Cancel</Button>
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmDeleteModal
        open={deleteTarget != null}
        title="Delete Class"
        message={deleteTarget ? `Delete class "${deleteTarget.label}"? Assigned devices are unassigned, not deleted.` : ""}
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Card grid listing */}
      {err && !editState.open && <TabError message={err} />}
      {isLoading ? (
        <TabLoading />
      ) : classes.length === 0 ? (
        <EmptyState title="No classes defined yet" hint="Create a class with + New Entry above." />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
          {classes.map((sc) => {
            const assigned = devices.filter((d) => d.class_id === sc.id);
            const available = devices.filter((d) => d.class_id == null && !d.ignored);
            return (
              <Card key={sc.id} className="border-l-2" style={{ borderLeftColor: sc.color }}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: sc.color }} />
                      <span className="text-primary font-semibold text-[13px] truncate">{sc.label}</span>
                      <Badge tone={sc.allow_outside_rack ? "success" : "neutral"}>
                        {sc.allow_outside_rack ? "Outside allowed" : "Rack required"}
                      </Badge>
                    </div>
                    {sc.description && <div className="text-muted text-[10px] mt-0.5 ml-[18px]">{sc.description}</div>}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button size="sm" onClick={() => startEdit(sc)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleteTarget(sc)}>Delete</Button>
                  </div>
                </div>
                <DeviceAssignment
                  assigned={assigned}
                  available={available}
                  onAssign={(devId) => assignMutation.mutate({ id: String(devId), patch: { class_id: sc.id } })}
                  onUnassign={(devId) => assignMutation.mutate({ id: String(devId), patch: { class_id: null } })}
                />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ClassesTabContent;
