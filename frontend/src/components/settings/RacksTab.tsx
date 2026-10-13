import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, extractErrorMessage } from "../../api";
import type { RackInfo, TopologyNode } from "../../types";
import { queryKeys, useDevices, useInvalidateApi, useRacks } from "../../hooks/api";
import { Button, Card, EmptyState, Input, Modal } from "../ui";
import { ConfirmDeleteModal, DeviceAssignment, Field, TabLoading } from "./shared";

// ── RacksTabContent ──────────────────────────────────────────────────────────
interface RackForm {
  label: string;
  room: string;
  description: string;
  height_u: number | string;
}

interface EditState {
  id: number | null;
  open: boolean;
}

interface RacksTabContentProps {
  newEntryTrigger: number;
}

const EMPTY_RACK_FORM: RackForm = { label: "", room: "", description: "", height_u: 42 };

function RacksTabContent({ newEntryTrigger }: RacksTabContentProps) {
  const { data: racks = [], isLoading } = useRacks();
  const { data: devicesRaw } = useDevices();
  const { invalidate } = useInvalidateApi();

  const devices: TopologyNode[] = Array.isArray(devicesRaw) ? devicesRaw : [];

  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm] = useState<RackForm>({ ...EMPTY_RACK_FORM });
  const [err, setErr] = useState<string>("");
  const [assignSel, setAssignSel] = useState<Record<number, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<RackInfo | null>(null);

  useEffect(() => {
    if (newEntryTrigger > 0) { startNew(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntryTrigger]);

  const resetForm = () => { setForm({ ...EMPTY_RACK_FORM }); setEditState({ id: null, open: false }); setErr(""); };
  const startNew = () => { setForm({ ...EMPTY_RACK_FORM }); setEditState({ id: null, open: true }); setErr(""); };
  const startEdit = (r: RackInfo) => {
    setEditState({ id: r.id, open: true });
    setForm({ label: r.label, room: r.room, description: r.description ?? "", height_u: r.height_u ?? 42 });
    setErr("");
  };

  const invalidateRacks = () => {
    invalidate(queryKeys.racks, queryKeys.devices, queryKeys.topology, queryKeys.stats);
  };

  const saveMutation = useMutation({
    mutationFn: async (values: { id: number | null; form: RackForm }) => {
      const payload = {
        label: values.form.label,
        room: values.form.room,
        description: values.form.description,
        height_u: Math.max(6, Math.min(60, Number(values.form.height_u) || 42)),
      };
      if (values.id) {
        await api.put(`/api/racks/${values.id}`, payload);
      } else {
        const r = await api.post<{ detail?: unknown }>("/api/racks", payload);
        if (r.detail) throw new Error(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail));
      }
    },
    onSuccess: () => {
      invalidateRacks();
      resetForm();
    },
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.del(`/api/racks/${id}`),
    onSuccess: () => {
      invalidateRacks();
      setDeleteTarget(null);
    },
  });

  const assignMutation = useMutation({
    mutationFn: ({ devId, rackId }: { devId: string; rackId: number | null }) =>
      api.patch(`/api/topology/devices/${devId}/meta`, { rack_id: rackId }),
    onSuccess: (_data, vars) => {
      invalidate(queryKeys.topology, queryKeys.racks, queryKeys.devices, queryKeys.credentials);
      const rackId = vars.rackId;
      if (rackId != null) setAssignSel((prev) => ({ ...prev, [rackId]: "" }));
    },
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr("");
    if (!form.label.trim()) { setErr("Label is required"); return; }
    saveMutation.mutate({ id: editState.id, form });
  };

  return (
    <div className="flex-1 overflow-y-auto pt-5">
      {/* New / edit rack dialog */}
      <Modal open={editState.open} onClose={resetForm} title={editState.id ? "Edit Rack" : "New Rack"} width={480}>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Label">
                <Input required value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Rack A" />
              </Field>
              <Field label="Room / location">
                <Input value={form.room} onChange={(e) => setForm((f) => ({ ...f, room: e.target.value }))} placeholder="e.g. RZ-01" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Height (U)">
                <Input
                  type="number"
                  min={6}
                  max={60}
                  value={form.height_u}
                  onChange={(e) => setForm((f) => ({ ...f, height_u: e.target.value }))}
                />
              </Field>
              <Field label="Description">
                <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="optional" />
              </Field>
            </div>
            {err && <div className="text-[11px] text-danger">{err}</div>}
            <div className="flex gap-2 mt-1">
              <Button type="submit" variant="primary" className="flex-1" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : editState.id ? "Save" : "Create rack"}
              </Button>
              <Button type="button" onClick={resetForm}>Cancel</Button>
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmDeleteModal
        open={deleteTarget != null}
        title="Delete Rack"
        message={deleteTarget ? `Delete rack "${deleteTarget.label}"? Assigned switches are unassigned, not deleted.` : ""}
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Card grid listing */}
      {isLoading ? (
        <TabLoading />
      ) : racks.length === 0 ? (
        <EmptyState title="No racks defined yet" hint="Create a rack with + New Entry above." />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
          {racks.map((rack) => {
            const assigned = devices.filter((d) => d.rack_id === rack.id);
            const available = devices.filter((d) => d.rack_id == null && !d.ignored);
            const selVal = assignSel[rack.id] || "";
            return (
              <Card key={rack.id}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-primary font-semibold text-[13px] truncate">{rack.label}</span>
                      <span className="text-[10px] text-muted">{rack.height_u ?? 42}U</span>
                    </div>
                    {(rack.room || rack.description) && (
                      <div className="text-muted text-[10px] mt-0.5">
                        {rack.room}{rack.room && rack.description ? " - " : ""}{rack.description}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1.5 shrink-0 items-center">
                    <Link
                      to={`/racks?rack=${rack.id}`}
                      className="text-accent text-[10px] hover:underline whitespace-nowrap"
                    >
                      Open elevation
                    </Link>
                    <Button size="sm" onClick={() => startEdit(rack)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleteTarget(rack)}>Delete</Button>
                  </div>
                </div>
                <DeviceAssignment
                  assigned={assigned}
                  available={available}
                  selVal={selVal}
                  onSelect={(val) => setAssignSel((p) => ({ ...p, [rack.id]: val }))}
                  onAssign={() => assignMutation.mutate({ devId: selVal, rackId: rack.id })}
                  onUnassign={(devId) => assignMutation.mutate({ devId: String(devId), rackId: null })}
                />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default RacksTabContent;
