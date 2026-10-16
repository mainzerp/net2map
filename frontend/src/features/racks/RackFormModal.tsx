// ── RackFormModal ────────────────────────────────────────────────────────────
// Create/edit dialog for a rack (physical cabinet on a floor). Shared by
// Settings > Racks and the /racks elevation page. Owns its form state,
// validation and the save mutation; the payload is label, room, description,
// height_u and floor_id.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { extractErrorMessage } from "../../api";
import { queryKeys, useBuildings, useRacks, useSaveRack } from "../../hooks/api";
import { Button, Input, Modal, Select } from "../../components/ui";
import { Field } from "../../components/settings/shared";
import { flattenFloors } from "../topology/floors";
import type { RackInfo } from "../../types";

export const RACK_HEIGHT_MIN = 6;
export const RACK_HEIGHT_MAX = 60;
export const RACK_HEIGHT_DEFAULT = 42;

interface RackForm {
  label: string;
  room: string;
  description: string;
  height_u: string;
  floor_id: number | null;
}

const EMPTY_FORM: RackForm = {
  label: "",
  room: "",
  description: "",
  height_u: String(RACK_HEIGHT_DEFAULT),
  floor_id: null,
};

function formOf(rack: RackInfo | null | undefined): RackForm {
  if (!rack) return { ...EMPTY_FORM };
  return {
    label: rack.label,
    room: rack.room ?? "",
    description: rack.description ?? "",
    height_u: String(rack.height_u ?? RACK_HEIGHT_DEFAULT),
    floor_id: rack.floor_id ?? null,
  };
}

/**
 * Parse the height field: blank falls back to the default, anything else must
 * be a whole number in range. Returns the value or an error message.
 */
export function parseRackHeight(raw: string): { value: number } | { error: string } {
  const text = raw.trim();
  if (text === "") return { value: RACK_HEIGHT_DEFAULT };
  const n = Number(text);
  if (!Number.isInteger(n) || n < RACK_HEIGHT_MIN || n > RACK_HEIGHT_MAX) {
    return { error: `Height must be a whole number from ${RACK_HEIGHT_MIN} to ${RACK_HEIGHT_MAX} U` };
  }
  return { value: n };
}

export interface RackFormModalProps {
  open: boolean;
  // Rack to edit; null/undefined creates a new rack.
  rack?: RackInfo | null;
  onClose: () => void;
  // Called after a successful save with the saved rack (for a new rack, once
  // the refreshed rack list contains it).
  onSaved?: (rack: RackInfo) => void;
}

export default function RackFormModal({ open, rack, onClose, onSaved }: RackFormModalProps) {
  const queryClient = useQueryClient();
  const { data: buildings = [] } = useBuildings();
  // Keeps the rack list observed so a new rack can be resolved after saving.
  const { data: racks = [] } = useRacks();
  const floors = flattenFloors(buildings);
  const hasFloors = floors.length > 0;
  const editId = rack?.id ?? null;

  const [form, setForm] = useState<RackForm>(() => formOf(rack));
  const [err, setErr] = useState("");
  const [touchedHeight, setTouchedHeight] = useState(false);
  const knownIds = useRef<Set<number>>(new Set());

  // Reset the form whenever the dialog opens (or switches to another rack).
  useEffect(() => {
    if (!open) return;
    setForm(formOf(rack));
    setErr("");
    setTouchedHeight(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  const height = parseRackHeight(form.height_u);
  const heightError = "error" in height && touchedHeight ? height.error : undefined;

  const saveMutation = useSaveRack({
    onSuccess: async (_data, { payload }) => {
      const saved = payload as Omit<RackInfo, "id">;
      if (editId != null && rack) {
        onSaved?.({ ...rack, ...saved, id: editId });
      } else if (onSaved) {
        // The create endpoint result is not exposed by the hook: resolve the
        // new rack from the refreshed list (new id, same label preferred).
        await queryClient.refetchQueries({ queryKey: queryKeys.racks, exact: true });
        const list = queryClient.getQueryData<RackInfo[]>(queryKeys.racks) ?? [];
        const fresh = list.filter((r) => !knownIds.current.has(r.id));
        const created = fresh.find((r) => r.label === saved.label) ?? fresh[fresh.length - 1];
        if (created) onSaved(created);
      }
      onClose();
    },
    onError: (ex) => setErr(extractErrorMessage(ex)),
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr("");
    setTouchedHeight(true);
    if (!form.label.trim()) {
      setErr("Label is required");
      return;
    }
    if ("error" in height) return;
    knownIds.current = new Set(racks.map((r) => r.id));
    const payload = {
      label: form.label,
      room: form.room,
      description: form.description,
      height_u: height.value,
      floor_id: form.floor_id,
    };
    saveMutation.mutate({ id: editId, payload });
  };

  // A floor id that no longer exists (deleted meanwhile) stays selectable.
  const knownFloor = form.floor_id == null || floors.some((f) => f.floor.id === form.floor_id);

  return (
    <Modal open={open} onClose={onClose} title={editId ? "Edit Rack" : "New Rack"} width={480}>
      <form onSubmit={submit} noValidate>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Label">
              <Input
                required
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Rack A"
              />
            </Field>
            <Field label="Room / location">
              <Input
                value={form.room}
                onChange={(e) => setForm((f) => ({ ...f, room: e.target.value }))}
                placeholder="e.g. RZ-01"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Height (U)" hint={`${RACK_HEIGHT_MIN}-${RACK_HEIGHT_MAX} U`} error={heightError}>
              <Input
                type="number"
                min={RACK_HEIGHT_MIN}
                max={RACK_HEIGHT_MAX}
                invalid={heightError != null}
                value={form.height_u}
                onChange={(e) => {
                  setTouchedHeight(true);
                  setForm((f) => ({ ...f, height_u: e.target.value }));
                }}
              />
            </Field>
            <Field label="Description">
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="optional"
              />
            </Field>
          </div>
          <Field
            label="Floor"
            hint={
              hasFloors ? (
                "The floor map shows the rack; devices in it inherit this floor."
              ) : (
                <>
                  No floors yet.{" "}
                  <Link to="/settings/floors" className="text-accent hover:underline" onClick={onClose}>
                    Create a building and floor first
                  </Link>
                </>
              )
            }
          >
            <Select
              value={form.floor_id == null ? "" : String(form.floor_id)}
              disabled={!hasFloors && knownFloor}
              onChange={(e) =>
                setForm((f) => ({ ...f, floor_id: e.target.value === "" ? null : Number(e.target.value) }))
              }
            >
              <option value="">None</option>
              {!knownFloor && <option value={String(form.floor_id)}>Unknown floor</option>}
              {floors.map(({ floor, building }) => (
                <option key={floor.id} value={floor.id}>
                  {building.label} / {floor.label}
                </option>
              ))}
            </Select>
          </Field>
          {err && <div className="text-[11px] text-danger" role="alert">{err}</div>}
          <div className="flex gap-2 mt-1">
            <Button type="submit" variant="primary" className="flex-1" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving..." : editId ? "Save" : "Create rack"}
            </Button>
            <Button type="button" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
