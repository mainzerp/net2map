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

interface AssignError {
  classId: number;
  message: string;
}

interface ClassesTabContentProps {
  newEntryTrigger: number;
}

// Default for a user-chosen class color (data, not UI chrome): the palette ink
// blue from theme/visual.ts. A native color input needs a hex value.
// New classes show unracked devices on the map, so creating a class never
// hides devices; editing keeps the stored value.
const EMPTY_CLASS_FORM: ClassForm = { label: "", description: "", color: DEFAULT_SWITCH_CLASS_COLOR, allow_outside_rack: true };

const RACK_REQUIRED_TITLE = "Devices of this class must be placed in a rack; unracked ones are hidden from the map.";
const SHOWN_WITHOUT_RACK_TITLE = "Devices of this class appear on the map even when they are not placed in a rack.";

function ClassesTabContent({ newEntryTrigger }: ClassesTabContentProps) {
  const { data: classes = [], isLoading } = useSwitchClasses();
  const { data: devicesRaw } = useDevices();

  const devices: TopologyNode[] = Array.isArray(devicesRaw) ? devicesRaw : [];

  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm] = useState<ClassForm>({ ...EMPTY_CLASS_FORM });
  const [err, setErr] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<SwitchClass | null>(null);
  const [assignErr, setAssignErr] = useState<AssignError | null>(null);

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

  const assignMutation = useUpdateDeviceMeta();

  // Assign / unassign for one class card; a failure is shown on that card.
  const patchClass = (classId: number, devId: number, nextClassId: number | null) => {
    setAssignErr(null);
    assignMutation.mutate(
      { id: String(devId), patch: { class_id: nextClassId } },
      { onError: (ex) => setAssignErr({ classId, message: extractErrorMessage(ex) }) },
    );
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr("");
    if (!form.label.trim()) { setErr("Label is required"); return; }
    saveMutation.mutate({ id: editState.id, form });
  };

  return (
    <div className="flex-1 overflow-y-auto pt-5">
      {/* New / edit class dialog */}
      <Modal open={editState.open} onClose={resetForm} title={editState.id ? "Edit device class" : "New device class"} width={480}>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
              <Field label="Label">
                <Input required value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Top of Rack" />
              </Field>
              <Field label="Color">
                <span className="flex items-center gap-1.5">
                  <input
                    type="color"
                    aria-label="Color"
                    value={form.color}
                    onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                    className="w-10 h-[29px] p-0.5 bg-panel-2 border border-line-strong rounded cursor-pointer"
                  />
                  {/* Preview of how the class marks devices on the map and in tables. */}
                  <span
                    data-testid="class-color-preview"
                    className="w-3 h-3 rounded-full shrink-0 border border-line"
                    style={{ backgroundColor: form.color }}
                    aria-hidden="true"
                  />
                </span>
              </Field>
            </div>
            <Field label="Description">
              <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="optional" />
            </Field>
            <Field
              label="Map visibility"
              hint="Off: devices of this class must be placed in a rack; unracked ones are hidden from the map."
            >
              <span className="flex items-center gap-1.5 text-[11px] text-primary cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="accent-accent"
                  aria-label="Show devices without a rack on the map"
                  checked={!!form.allow_outside_rack}
                  onChange={(e) => setForm((f) => ({ ...f, allow_outside_rack: e.target.checked }))}
                />
                Show devices without a rack on the map
              </span>
            </Field>
            {err && <div className="text-[11px] text-danger">{err}</div>}
            <div className="flex gap-2 mt-1">
              <Button type="submit" variant="primary" className="flex-1" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : editState.id ? "Save" : "Create device class"}
              </Button>
              <Button type="button" onClick={resetForm}>Cancel</Button>
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmDeleteModal
        open={deleteTarget != null}
        title="Delete device class"
        message={deleteTarget ? `Delete device class "${deleteTarget.label}"? Assigned devices are unassigned, not deleted.` : ""}
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Card grid listing */}
      {err && !editState.open && <TabError message={err} />}
      {isLoading ? (
        <TabLoading />
      ) : classes.length === 0 ? (
        <EmptyState
          title="No device classes defined yet"
          hint="A device class is your own role label (Core, Access, Server...) that colors devices on the map and in tables and decides whether devices without a rack appear on the map. Create one with the New class button above."
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
          {classes.map((sc) => {
            const assigned = devices.filter((d) => d.class_id === sc.id);
            const rackRequired = !sc.allow_outside_rack;
            // The backend rejects a rack-required class for unracked devices,
            // so only offer devices that already sit in a rack.
            const available = devices.filter(
              (d) => d.class_id == null && !d.ignored && (!rackRequired || d.rack_id != null),
            );
            return (
              <Card key={sc.id} className="border-l-2" style={{ borderLeftColor: sc.color }}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: sc.color }} />
                      <span className="text-primary font-semibold text-[13px] truncate">{sc.label}</span>
                      <Badge
                        tone={rackRequired ? "neutral" : "success"}
                        title={rackRequired ? RACK_REQUIRED_TITLE : SHOWN_WITHOUT_RACK_TITLE}
                      >
                        {rackRequired ? "Rack required" : "Shown without rack"}
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
                  onAssign={(devId) => patchClass(sc.id, devId, sc.id)}
                  onUnassign={(devId) => patchClass(sc.id, devId, null)}
                  hint={rackRequired ? "Only devices in a rack can get this class (rack required)." : undefined}
                  emptyPlaceholder={rackRequired ? "No unclassified devices in a rack" : undefined}
                  error={assignErr?.classId === sc.id ? assignErr.message : undefined}
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
