import { useMemo, useState } from "react";
import { extractErrorMessage, getStoredUser } from "../../api";
import type { PingCandidate, PingOnlyAdoptResult } from "../../types";
import {
  useAdoptPingOnly,
  useDismissPingCandidates,
  usePingCandidates,
  useRestorePingCandidates,
} from "../../hooks/api";
import { Badge, Button, Card, DataTable, EmptyState, type DataTableColumn } from "../ui";
import { useToast } from "../ToastProvider";
import { formatTimestamp } from "../../utils/datetime";
import { matchesQuery } from "../../utils/deviceSearch";
import { SectionHeader, TabLoading } from "./shared";

// Hosts in the discovery ranges that answered ping but not SNMP and are not
// managed yet. Write users can adopt them as ping-only devices or dismiss
// them; viewers see the list read-only.
// ``search`` comes from the Network Devices search field and filters by IP,
// DNS name and MAC.
export default function PingCandidatesSection({ search = "" }: { search?: string }) {
  const canEdit = (getStoredUser()?.role ?? "viewer") !== "viewer";
  const [showDismissed, setShowDismissed] = useState(false);
  const [selected, setSelected] = useState<Set<string | number>>(new Set());
  const { data: candidates = [], isLoading, isError, error } = usePingCandidates(showDismissed);
  const adoptMutation = useAdoptPingOnly();
  const dismissMutation = useDismissPingCandidates();
  const restoreMutation = useRestorePingCandidates();
  const { addToast } = useToast();
  const busy = adoptMutation.isPending || dismissMutation.isPending || restoreMutation.isPending;

  const sorted = useMemo(
    () =>
      candidates
        .filter((c) => matchesQuery(search, [c.ip, c.hostname, c.mac, c.vendor]))
        .sort(
          (a, b) => Number(a.dismissed) - Number(b.dismissed) || a.ip.localeCompare(b.ip, undefined, { numeric: true }),
        ),
    [candidates, search],
  );
  // Only active (not dismissed) candidates that are still listed count as selected.
  const selectedActive = useMemo(
    () => sorted.filter((c) => selected.has(c.id) && !c.dismissed),
    [sorted, selected],
  );

  const reportAdopt = (result: PingOnlyAdoptResult) => {
    const added = result.created.length;
    const skipped = result.skipped.length;
    if (added === 1 && skipped === 0) {
      addToast(`Added ${result.created[0].ip} as ping-only device`, "success");
    } else {
      addToast(`${added} added, ${skipped} skipped`, added > 0 ? "success" : "warning");
    }
  };

  const adopt = (rows: PingCandidate[]) => {
    if (rows.length === 0) return;
    const entries = rows.map((c) => {
      const label = c.hostname?.trim() || "";
      return label ? { ip: c.ip, label } : { ip: c.ip };
    });
    adoptMutation.mutate(entries, {
      onSuccess: (result) => {
        setSelected(new Set());
        reportAdopt(result);
      },
      onError: (ex) => addToast(`Failed to add ping-only devices: ${extractErrorMessage(ex)}`, "error"),
    });
  };

  const dismiss = (ids: number[]) => {
    if (ids.length === 0) return;
    dismissMutation.mutate(ids, {
      onSuccess: () => setSelected(new Set()),
      onError: (ex) => addToast(`Failed to dismiss candidates: ${extractErrorMessage(ex)}`, "error"),
    });
  };

  const restore = (ids: number[]) => {
    restoreMutation.mutate(ids, {
      onError: (ex) => addToast(`Failed to restore candidates: ${extractErrorMessage(ex)}`, "error"),
    });
  };

  const columns: DataTableColumn<PingCandidate>[] = [
    {
      key: "ip",
      header: "IP",
      sortable: true,
      sortValue: (c) => c.ip,
      render: (c) => (
        <span className="inline-flex items-center gap-1.5">
          <span className={`font-mono ${c.dismissed ? "text-muted" : "text-primary font-semibold"}`}>{c.ip}</span>
          {c.dismissed && <Badge tone="neutral">dismissed</Badge>}
        </span>
      ),
    },
    {
      key: "hostname",
      header: "Hostname",
      sortable: true,
      sortValue: (c) => (c.hostname || "").toLowerCase(),
      render: (c) => <span className="text-muted">{c.hostname || "-"}</span>,
    },
    {
      key: "vendor",
      header: "Vendor",
      sortable: true,
      sortValue: (c) => (c.vendor || "").toLowerCase(),
      render: (c) => <span className="text-muted">{c.vendor || "-"}</span>,
    },
    {
      key: "mac",
      header: "MAC",
      render: (c) => <span className="font-mono text-muted">{c.mac || "-"}</span>,
    },
    {
      key: "rtt",
      header: "RTT",
      align: "right",
      sortable: true,
      sortValue: (c) => c.rtt_ms ?? Number.MAX_SAFE_INTEGER,
      render: (c) => (
        <span className="font-mono text-muted">{c.rtt_ms != null ? `${c.rtt_ms.toFixed(1)} ms` : "-"}</span>
      ),
    },
    {
      key: "last_seen",
      header: "Last seen",
      sortable: true,
      sortValue: (c) => c.last_seen || "",
      render: (c) => <span className="text-muted">{c.last_seen ? formatTimestamp(c.last_seen) : "-"}</span>,
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      header: "Actions",
      align: "right",
      render: (c) =>
        c.dismissed ? (
          <Button size="sm" disabled={busy} onClick={() => restore([c.id])} aria-label={`Restore ${c.ip}`}>
            Restore
          </Button>
        ) : (
          <span className="inline-flex gap-1.5">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => adopt([c])} aria-label={`Adopt ${c.ip}`}>
              Adopt
            </Button>
            <Button size="sm" disabled={busy} onClick={() => dismiss([c.id])} aria-label={`Dismiss ${c.ip}`}>
              Dismiss
            </Button>
          </span>
        ),
    });
  }

  return (
    <section className="mt-5 flex flex-col gap-2" aria-labelledby="ping-candidates-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div id="ping-candidates-heading">
          <SectionHeader>PING-ONLY CANDIDATES ({sorted.filter((c) => !c.dismissed).length})</SectionHeader>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            className="accent-accent"
            checked={showDismissed}
            onChange={(e) => {
              setShowDismissed(e.target.checked);
              setSelected(new Set());
            }}
          />
          Show dismissed
        </label>
      </div>
      <p className="text-[11px] text-muted">
        Hosts in the discovery ranges that answer ping but not SNMP. Adopt them to monitor reachability and latency
        as ping-only devices.
      </p>

      {canEdit && selectedActive.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-panel-2 border border-line-strong rounded-card">
          <span className="text-xs font-semibold text-accent">{selectedActive.length} selected</span>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => adopt(selectedActive)}>
            {adoptMutation.isPending ? "Adding..." : "Adopt selected"}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => dismiss(selectedActive.map((c) => c.id))}>
            Dismiss selected
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {isLoading ? (
        <TabLoading />
      ) : isError ? (
        <Card>
          <div className="text-xs text-danger">Failed to load candidates: {extractErrorMessage(error)}</div>
        </Card>
      ) : sorted.length === 0 ? (
        <Card>
          <EmptyState
            title={search && candidates.length > 0 ? "No candidates match your search" : "No ping-only candidates"}
            hint={
              search && candidates.length > 0
                ? undefined
                : showDismissed
                ? "No hosts answered ping without SNMP in the discovery ranges."
                : "No new hosts answered ping without SNMP. Dismissed hosts are hidden."
            }
          />
        </Card>
      ) : (
        <DataTable
          columns={columns}
          rows={sorted}
          rowKey={(c) => c.id}
          selectable={canEdit}
          selectedKeys={selected}
          onSelectionChange={setSelected}
          rowClassName={(c) => (c.dismissed ? "opacity-60" : "")}
          defaultPageSize={25}
        />
      )}
    </section>
  );
}
