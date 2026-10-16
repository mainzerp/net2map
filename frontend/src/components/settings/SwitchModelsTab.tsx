import { useState, useEffect } from "react";
import { extractErrorMessage } from "../../api";
import type { SwitchModel, TopologyNode } from "../../types";
import {
  useDeleteSwitchModel,
  useDevices,
  useSaveSwitchModel,
  useSwitchModels,
  useUpdateDeviceMeta,
} from "../../hooks/api";
import { Badge, Button, Card, EmptyState, Input, Modal } from "../ui";
import { ConfirmDeleteModal, DeviceAssignment, Field, TabLoading } from "./shared";
import { deviceDisplayName } from "../../utils/deviceSearch";

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

interface AssignError {
  modelId: number;
  message: string;
}

interface ModelsTabContentProps {
  newEntryTrigger: number;
}

const EMPTY_MODEL_FORM: ModelForm = { name: "", ports_per_row: 24, total_ports: "", description: "" };

// Shortest SNMP model string considered for a name match; shorter strings
// (or empty ones) would match nearly every hardware model.
const MIN_MATCH_LENGTH = 3;

// True when the device-reported model string and the hardware model name
// contain each other (case-insensitive).
function modelNameMatches(reported: string | null | undefined, name: string): boolean {
  const a = (reported ?? "").trim().toLowerCase();
  const b = name.trim().toLowerCase();
  if (a.length < MIN_MATCH_LENGTH || b.length < MIN_MATCH_LENGTH) return false;
  return a.includes(b) || b.includes(a);
}

// Most preview cells drawn; enough for two rows of a 48-port switch.
const PREVIEW_MAX_CELLS = 96;

// Compact faceplate sketch for the model dialog: each column is an odd/even
// port pair, like the map's device panel. Purely presentational.
function PortLayoutPreview({ portsPerRow, totalPorts }: { portsPerRow: number; totalPorts: number | null }) {
  const portsInRow = portsPerRow * 2;
  const cells = Math.min(totalPorts ?? portsInRow * 2, portsInRow * 2, PREVIEW_MAX_CELLS);
  const rows: number[] = [];
  for (let start = 0; start < cells; start += portsInRow) rows.push(Math.min(portsInRow, cells - start));
  const summary = `${portsInRow} ports per row, ${totalPorts != null ? `${totalPorts} visible` : "all visible"}`;
  return (
    <div>
      <div className="text-[10px] text-muted select-none mb-1">Preview</div>
      <div className="rounded border border-line p-2 overflow-hidden">
        <div aria-hidden="true" data-testid="port-layout-preview" className="flex flex-col gap-1">
          {rows.map((count, r) => (
            <div key={r} className="grid grid-flow-col grid-rows-2 auto-cols-[6px] gap-px">
              {Array.from({ length: count }, (_, i) => (
                <span key={i} className="w-[6px] h-[6px] rounded-[1px] border border-line-strong bg-panel-2" />
              ))}
            </div>
          ))}
        </div>
        <div className="mt-1.5 text-[11px] text-muted">{summary}</div>
      </div>
    </div>
  );
}

function ModelsTabContent({ newEntryTrigger }: ModelsTabContentProps) {
  const { data: models = [], isLoading } = useSwitchModels();
  const { data: devicesRaw } = useDevices();

  const devices: TopologyNode[] = Array.isArray(devicesRaw) ? devicesRaw : [];

  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm] = useState<ModelForm>({ ...EMPTY_MODEL_FORM });
  const [cutoffEnabled, setCutoffEnabled] = useState<boolean>(false);
  const [err, setErr] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<SwitchModel | null>(null);
  const [assignErr, setAssignErr] = useState<AssignError | null>(null);
  const [bulkBusy, setBulkBusy] = useState<number | null>(null);

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

  const saveMutation = useSaveSwitchModel({
    onSuccess: () => resetForm(),
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const deleteMutation = useDeleteSwitchModel({
    onSuccess: () => setDeleteTarget(null),
  });

  const assignMutation = useUpdateDeviceMeta();

  // Assign / unassign for one model card; a failure is shown on that card.
  const patchModel = (modelId: number, devId: number, nextModelId: number | null) => {
    setAssignErr(null);
    assignMutation.mutate(
      { id: String(devId), patch: { model_id: nextModelId } },
      { onError: (ex) => setAssignErr({ modelId, message: extractErrorMessage(ex) }) },
    );
  };

  // Assigns every suggested device in sequence; stops at the first failure.
  const assignAll = async (modelId: number, devs: TopologyNode[]) => {
    setAssignErr(null);
    setBulkBusy(modelId);
    try {
      for (const d of devs) {
        await assignMutation.mutateAsync({ id: String(d.id), patch: { model_id: modelId } });
      }
    } catch (ex) {
      setAssignErr({ modelId, message: extractErrorMessage(ex) });
    } finally {
      setBulkBusy(null);
    }
  };

  const previewPpr = Math.min(Math.max(parseInt(String(form.ports_per_row), 10) || 1, 1), 96);
  const previewTotalRaw = cutoffEnabled ? parseInt(String(form.total_ports), 10) : NaN;
  const previewTotal = Number.isFinite(previewTotalRaw) && previewTotalRaw > 0 ? previewTotalRaw : null;

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr("");
    const ppr = parseInt(String(form.ports_per_row), 10);
    if (!String(form.name).trim()) { setErr("Name is required"); return; }
    if (isNaN(ppr) || ppr < 1) { setErr("Port columns per row must be a positive number"); return; }
    const payload = {
      name: String(form.name).trim(),
      ports_per_row: ppr,
      total_ports: cutoffEnabled && form.total_ports !== "" ? parseInt(String(form.total_ports), 10) || null : null,
      description: form.description,
    };
    saveMutation.mutate({ id: editState.id, payload });
  };

  return (
    <div className="flex-1 overflow-y-auto pt-5">
      {/* New / edit model dialog */}
      <Modal open={editState.open} onClose={resetForm} title={editState.id ? "Edit hardware model" : "New hardware model"} width={520}>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <Field label="Name">
              <Input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Aruba CX 6300M-48" />
            </Field>
            <Field
              label="Port columns per row"
              hint="Each column holds an odd/even port pair, so 24 columns show 48 ports per row (map device panel)."
            >
              <Input type="number" min="1" max="96" value={form.ports_per_row} onChange={(e) => setForm((f) => ({ ...f, ports_per_row: e.target.value }))} />
            </Field>
            <div>
              <div id="model-total-ports-label" className="text-[10px] text-muted select-none mb-1">Total ports (cutoff)</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={cutoffEnabled}
                  aria-labelledby="model-total-ports-label"
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
                    aria-label="Total ports"
                    value={form.total_ports}
                    onChange={(e) => setForm((f) => ({ ...f, total_ports: e.target.value }))}
                    placeholder="e.g. 48"
                    autoFocus
                  />
                ) : (
                  <span className="text-muted text-[10px]">disabled</span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-muted leading-snug">
                Ports above this number are hidden (e.g. uplink or virtual ports).
              </div>
            </div>
            <PortLayoutPreview portsPerRow={previewPpr} totalPorts={previewTotal} />
            <Field label="Description">
              <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="optional" />
            </Field>
            {err && <div className="text-[11px] text-danger">{err}</div>}
            <div className="flex gap-2 mt-1">
              <Button type="submit" variant="primary" className="flex-1" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : editState.id ? "Save" : "Create hardware model"}
              </Button>
              <Button type="button" onClick={resetForm}>Cancel</Button>
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmDeleteModal
        open={deleteTarget != null}
        title="Delete hardware model"
        message={deleteTarget ? `Delete hardware model "${deleteTarget.name}"? Assigned devices are unassigned, not deleted.` : ""}
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Card grid listing */}
      {isLoading ? (
        <TabLoading />
      ) : models.length === 0 ? (
        <EmptyState
          title="No hardware models defined yet"
          hint="A hardware model is a port layout template for the device faceplate on the map and in the rack view; it is not the model string the device reports. Create one with the New model button above."
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
          {models.map((sm) => {
            const assigned = devices.filter((d) => d.model_id === sm.id);
            const available = devices.filter((d) => d.model_id == null && !d.ignored);
            const suggested = available.filter((d) => modelNameMatches(d.model, sm.name));
            const bulkRunning = bulkBusy === sm.id;
            return (
              <Card key={sm.id} className="border-l-2 border-l-accent">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-primary font-semibold text-[13px] truncate">{sm.name}</span>
                      <Badge tone="accent" title={`${sm.ports_per_row} port columns per row`}>
                        {sm.ports_per_row * 2} ports/row
                      </Badge>
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
                {suggested.length > 0 && (
                  <div className="mt-2.5 rounded border border-line bg-panel-2 px-2 py-1.5" data-testid={`model-suggestions-${sm.id}`}>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 text-[11px] text-primary">
                        {suggested.length} {suggested.length === 1 ? "device reports" : "devices report"} a matching model
                      </span>
                      <Button
                        size="sm"
                        disabled={bulkRunning}
                        onClick={() => { void assignAll(sm.id, suggested); }}
                      >
                        {bulkRunning ? "Assigning..." : `Assign all ${suggested.length}`}
                      </Button>
                    </div>
                    <div className="mt-1 text-[10px] text-muted leading-snug">
                      {suggested.map((d) => `${deviceDisplayName(d)} (${d.model})`).join(", ")}
                    </div>
                  </div>
                )}
                <DeviceAssignment
                  assigned={assigned}
                  available={available}
                  onAssign={(devId) => patchModel(sm.id, devId, sm.id)}
                  onUnassign={(devId) => patchModel(sm.id, devId, null)}
                  error={assignErr?.modelId === sm.id ? assignErr.message : undefined}
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
