import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Combobox, Modal, Spinner } from "../ui";
import type { TopologyNode } from "../../types";
import { deviceDisplayName, filterDevices } from "../../utils/deviceSearch";

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
    <div className="px-3 py-2 mb-2 rounded-control border border-danger bg-danger-soft text-danger text-[11px]">
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
// currently assigned to an entry and offers a type-to-filter picker to assign
// free devices (several in a row; the search input keeps focus).
interface DeviceAssignmentProps {
  assigned: TopologyNode[];
  available: TopologyNode[];
  onAssign: (devId: number) => void;
  onUnassign: (devId: number) => void;
}

export function DeviceAssignment({ assigned, available, onAssign, onUnassign }: DeviceAssignmentProps) {
  const [query, setQuery] = useState("");
  // Devices picked but not yet gone from `available` (mutation + refetch in
  // flight) are hidden so a fast second pick never hits the same device.
  const [pending, setPending] = useState<Set<number>>(() => new Set());
  const availableKey = available.map((d) => d.id).join(",");
  useEffect(() => { setPending(new Set()); }, [availableKey]);

  const candidates = useMemo(
    () => available.filter((d) => !pending.has(d.id)),
    [available, pending],
  );
  const { matches, total } = useMemo(() => filterDevices(candidates, query), [candidates, query]);
  const more = total - matches.length;

  const assign = (d: TopologyNode) => {
    setPending((prev) => new Set(prev).add(d.id));
    onAssign(d.id);
  };

  return (
    <div className="mt-2.5 border-t border-line pt-2">
      <div className="text-muted text-[10px] tracking-[1px] mb-1.5 select-none">
        ASSIGNED DEVICES ({assigned.length})
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
                aria-label={`Unassign ${d.sys_name || d.ip}`}
              >x</button>
            </span>
          ))}
        </div>
      )}
      <Combobox
        query={query}
        onQueryChange={setQuery}
        items={matches}
        getKey={(d) => d.id}
        onSelect={assign}
        ariaLabel="Assign device"
        placeholder={candidates.length === 0 ? "No unassigned devices" : "Search by name, IP, vendor, model..."}
        disabled={candidates.length === 0}
        emptyText="No matching devices"
        footer={more > 0 ? `${more} more, refine search` : undefined}
        renderItem={(d) => (
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="font-semibold truncate">{deviceDisplayName(d)}</span>
            <span className="text-muted tabular-nums">{d.ip}</span>
            {(d.vendor || d.model) && (
              <span className="text-muted truncate ml-auto">{[d.vendor, d.model].filter(Boolean).join(" ")}</span>
            )}
          </span>
        )}
      />
    </div>
  );
}
