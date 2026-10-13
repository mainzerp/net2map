// ── RackItemDialog ───────────────────────────────────────────────────────────
// Create, edit or delete a manually maintained rack item (patch panel, blank,
// cable manager, shelf, other). Items only occupy U space: no ports, no
// cabling, never scanned. Placement is validated client-side with the same
// rules as the backend (fit inside the rack, no overlap with devices or other
// items); server errors are shown inline.

import { useEffect, useId, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { extractErrorMessage } from "../../api";
import { Button, Input, Modal, Select } from "../../components/ui";
import { useCreateRackItem, useDeleteRackItem, useUpdateRackItem } from "../../hooks/api";
import type { RackItem, RackItemKind } from "../../types";
import { itemPlacementError, type Placement } from "./rackLayout";

export const RACK_ITEM_KINDS: { value: RackItemKind; label: string }[] = [
  { value: "patch_panel", label: "Patch panel" },
  { value: "blank", label: "Blank panel" },
  { value: "cable_manager", label: "Cable manager" },
  { value: "shelf", label: "Shelf" },
  { value: "other", label: "Other" },
];

export function rackItemKindLabel(kind: string): string {
  return RACK_ITEM_KINDS.find((k) => k.value === kind)?.label ?? "Other";
}

interface RackItemDialogProps {
  open: boolean;
  onClose: () => void;
  rackId: number;
  heightU: number;
  // Item to edit; null opens the create form.
  item: RackItem | null;
  // Suggested U position for a new item.
  defaultPos: number;
  placements: Placement[];
  items: RackItem[];
  readOnly: boolean;
}

interface FormState {
  kind: RackItemKind;
  label: string;
  pos: string;
  uHeight: string;
  note: string;
}

function initialForm(item: RackItem | null, defaultPos: number): FormState {
  if (item) {
    return {
      kind: item.kind,
      label: item.label,
      pos: String(item.rack_u_position),
      uHeight: String(item.u_height),
      note: item.note ?? "",
    };
  }
  return { kind: "patch_panel", label: "", pos: String(defaultPos), uHeight: "1", note: "" };
}

export default function RackItemDialog({
  open,
  onClose,
  rackId,
  heightU,
  item,
  defaultPos,
  placements,
  items,
  readOnly,
}: RackItemDialogProps) {
  const [form, setForm] = useState<FormState>(() => initialForm(item, defaultPos));
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const idPrefix = useId();

  // Reset only when the dialog opens or switches to another item, so a
  // background refetch never discards in-progress edits.
  useEffect(() => {
    if (open) {
      setForm(initialForm(item, defaultPos));
      setServerError(null);
      setConfirmDelete(false);
    }
  }, [open, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const createMutation = useCreateRackItem(rackId);
  const updateMutation = useUpdateRackItem(rackId);
  const deleteMutation = useDeleteRackItem(rackId);
  const busy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  const pos = Number(form.pos);
  const uHeight = Number(form.uHeight);
  const placementError = useMemo(
    () => itemPlacementError(pos, uHeight, heightU, placements, items, item?.id ?? null),
    [pos, uHeight, heightU, placements, items, item],
  );

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || placementError || busy) return;
    setServerError(null);
    const body = {
      kind: form.kind,
      label: form.label.trim(),
      rack_u_position: pos,
      u_height: uHeight,
      note: form.note.trim() ? form.note.trim() : null,
    };
    const options = {
      onSuccess: () => onClose(),
      onError: (ex: unknown) => setServerError(extractErrorMessage(ex)),
    };
    if (item) updateMutation.mutate({ id: item.id, ...body }, options);
    else createMutation.mutate(body, options);
  };

  const onDelete = () => {
    if (!item || readOnly || busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteMutation.mutate(item.id, {
      onSuccess: () => onClose(),
      onError: (ex: unknown) => setServerError(extractErrorMessage(ex)),
    });
  };

  const title = readOnly ? "Rack item" : item ? "Edit rack item" : "Add rack item";
  const fieldId = (name: string) => `${idPrefix}-${name}`;
  const labelCls = "text-[11px] font-semibold text-muted";

  return (
    <Modal open={open} onClose={onClose} title={title} width={420}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3" data-testid="rack-item-form">
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId("kind")} className={labelCls}>Type</label>
          <Select
            id={fieldId("kind")}
            value={form.kind}
            disabled={readOnly}
            onChange={(e) => set("kind", e.target.value as RackItemKind)}
          >
            {RACK_ITEM_KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId("label")} className={labelCls}>Label</label>
          <Input
            id={fieldId("label")}
            value={form.label}
            maxLength={120}
            placeholder="e.g. PP-01 Floor 2"
            disabled={readOnly}
            onChange={(e) => set("label", e.target.value)}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex flex-col gap-1 flex-1">
            <label htmlFor={fieldId("pos")} className={labelCls}>U position (bottom)</label>
            <Input
              id={fieldId("pos")}
              type="number"
              min={1}
              max={heightU}
              value={form.pos}
              disabled={readOnly}
              invalid={!readOnly && placementError != null}
              onChange={(e) => set("pos", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1 flex-1">
            <label htmlFor={fieldId("height")} className={labelCls}>U height</label>
            <Input
              id={fieldId("height")}
              type="number"
              min={1}
              max={heightU}
              value={form.uHeight}
              disabled={readOnly}
              invalid={!readOnly && placementError != null}
              onChange={(e) => set("uHeight", e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId("note")} className={labelCls}>Note (optional)</label>
          <textarea
            id={fieldId("note")}
            value={form.note}
            maxLength={2000}
            rows={3}
            disabled={readOnly}
            onChange={(e) => set("note", e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-control bg-panel text-primary text-xs border border-line-strong outline-none resize-y placeholder:text-muted focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-accent"
          />
        </div>
        {!readOnly && placementError && (
          <div role="alert" data-testid="rack-item-placement-error" className="text-danger text-[11px]">
            {placementError}
          </div>
        )}
        {serverError && (
          <div role="alert" className="text-danger text-[11px]">
            {serverError}
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          {item && !readOnly && (
            <Button variant="danger" size="sm" onClick={onDelete} disabled={busy}>
              <Trash2 size={12} aria-hidden="true" />
              {confirmDelete ? "Confirm delete" : "Delete"}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button variant="primary" size="sm" type="submit" disabled={busy || placementError != null}>
                {item ? "Save" : "Add item"}
              </Button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
