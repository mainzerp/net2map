import type { ReactNode } from "react";
import { Button, Modal, Select, Spinner } from "../ui";
import type { TopologyNode } from "../../types";

// Shared building blocks for the settings tabs: uniform form rows, section
// headers, async states and the destructive-action confirm dialog.

export function Field({ label, error, children }: { label: ReactNode; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] text-muted select-none mb-1">{label}</span>
      {children}
      {error && <span className="block mt-1 text-[11px] text-danger">{error}</span>}
    </label>
  );
}

export function SectionHeader({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-bold tracking-[2px] text-muted select-none">{children}</div>;
}

export function TabLoading({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-muted text-xs">
      <Spinner size={14} />
      <span>{label}</span>
    </div>
  );
}

export function TabError({ message }: { message: string }) {
  return (
    <div className="px-3 py-2 mb-2 rounded-md border border-danger bg-panel-2 text-danger text-[11px]">
      {message}
    </div>
  );
}

interface ConfirmDeleteModalProps {
  open: boolean;
  title: string;
  message: ReactNode;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteModal({ open, title, message, busy = false, onConfirm, onCancel }: ConfirmDeleteModalProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title} width={400}>
      <div className="text-xs text-muted leading-relaxed">{message}</div>
      <div className="flex gap-2 mt-4">
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting..." : "Delete"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </Modal>
  );
}

// Shared assignment block used by the rack/class/model tabs: lists the devices
// currently assigned to an entry and offers a picker to assign a free device.
interface DeviceAssignmentProps {
  assigned: TopologyNode[];
  available: TopologyNode[];
  selVal: string;
  onSelect: (val: string) => void;
  onAssign: () => void;
  onUnassign: (devId: number) => void;
}

export function DeviceAssignment({ assigned, available, selVal, onSelect, onAssign, onUnassign }: DeviceAssignmentProps) {
  return (
    <div className="mt-2.5 border-t border-line pt-2">
      <div className="text-muted text-[10px] tracking-[1px] mb-1.5 select-none">
        ASSIGNED SWITCHES ({assigned.length})
      </div>
      {assigned.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {assigned.map((d) => (
            <span key={d.id} className="inline-flex items-center gap-1 rounded bg-panel-2 border border-line-strong px-1.5 py-0.5 text-[10px]">
              <span className="text-accent">{d.sys_name || d.ip}</span>
              <span className="text-muted">{d.ip}</span>
              <button
                type="button"
                onClick={() => onUnassign(d.id)}
                className="text-muted hover:text-danger cursor-pointer leading-none"
                title="Unassign"
              >x</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Select value={selVal} onChange={(e) => onSelect(e.target.value)} className="flex-1">
          <option value="">-- Assign switch --</option>
          {available.map((d) => <option key={d.id} value={d.id}>{d.sys_name || d.ip} ({d.ip})</option>)}
        </Select>
        <Button size="sm" variant="primary" disabled={!selVal} onClick={onAssign}>Assign</Button>
      </div>
    </div>
  );
}
