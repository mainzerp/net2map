import { useEffect, useState } from "react";
import { extractErrorMessage, getStoredUser } from "../../../api";
import {
  queryKeys,
  useCreateScanRange,
  useDeleteScanRange,
  useInvalidateApi,
  useScanAllRanges,
  useScanJob,
  useScanRangeNow,
  useScanRanges,
  useSnmpProfiles,
  useUpdateScanRange,
} from "../../../hooks/api";
import type { ScanRange, ScanRangeJob, ScanRangeSave, SnmpProfile } from "../../../types";
import { formatTimestamp } from "../../../utils/datetime";
import { useToast } from "../../ToastProvider";
import { Badge, Button, EmptyState, Input, Select } from "../../ui";
import { ConfirmDeleteModal, Field, TabLoading } from "../shared";

// ── DiscoveryRanges ──────────────────────────────────────────────────────────
// Per-range editor for the discovery IP ranges (/api/scan-ranges). Each range
// carries its own schedule (interval, else the global discovery interval),
// SNMP profile subset and enabled flag, and can be scanned on demand.

export const MIN_RANGE_INTERVAL_SEC = 60;
export const MAX_RANGE_INTERVAL_SEC = 604800;

type IntervalUnit = "sec" | "min";

interface RangeForm {
  cidr: string;
  label: string;
  interval: string;
  unit: IntervalUnit;
  profileIds: number[];
  enabled: boolean;
}

const EMPTY_FORM: RangeForm = { cidr: "", label: "", interval: "", unit: "min", profileIds: [], enabled: true };

function formFromRange(range: ScanRange): RangeForm {
  const sec = range.interval_sec;
  const asMinutes = sec != null && sec % 60 === 0;
  return {
    cidr: range.cidr,
    label: range.label ?? "",
    interval: sec == null ? "" : String(asMinutes ? sec / 60 : sec),
    unit: sec == null || asMinutes ? "min" : "sec",
    profileIds: [...(range.profile_ids ?? [])],
    enabled: range.enabled,
  };
}

/**
 * Convert the interval field to seconds: empty means "use the global
 * discovery interval" (null). Returns an error message for invalid input.
 */
export function parseIntervalSec(value: string, unit: IntervalUnit): { value: number | null; error: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { value: null, error: "" };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return { value: null, error: "Interval must be a positive number" };
  const seconds = Math.round(unit === "min" ? n * 60 : n);
  if (seconds < MIN_RANGE_INTERVAL_SEC || seconds > MAX_RANGE_INTERVAL_SEC) {
    return { value: null, error: "Interval must be between 1 minute and 7 days" };
  }
  return { value: seconds, error: "" };
}

function formToPayload(form: RangeForm): { payload: ScanRangeSave & { cidr: string }; error: string } {
  const cidr = form.cidr.trim();
  const interval = parseIntervalSec(form.interval, form.unit);
  const error = !cidr ? "CIDR or IP is required" : interval.error;
  return {
    payload: {
      cidr,
      label: form.label.trim(),
      enabled: form.enabled,
      interval_sec: interval.value,
      profile_ids: [...form.profileIds].sort((a, b) => a - b),
    },
    error,
  };
}

export function formatInterval(sec: number | null): string {
  if (sec == null) return "default";
  if (sec % 86400 === 0) return `${sec / 86400} d`;
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

function profileSummary(ids: number[], profiles: SnmpProfile[]): string {
  if (!ids || ids.length === 0) return "all";
  const byId = new Map(profiles.map((p) => [p.id, p.label]));
  return ids.map((id) => byId.get(id) ?? `#${id}`).join(", ");
}

interface RangeFieldsProps {
  idPrefix: string;
  form: RangeForm;
  onChange: (next: RangeForm) => void;
  profiles: SnmpProfile[];
  disabled: boolean;
  error: string;
}

// Shared field set for the add form and the inline row editor.
function RangeFields({ idPrefix, form, onChange, profiles, disabled, error }: RangeFieldsProps) {
  const set = <K extends keyof RangeForm>(key: K, value: RangeForm[K]) => onChange({ ...form, [key]: value });
  const toggleProfile = (id: number, checked: boolean) =>
    set("profileIds", checked ? [...form.profileIds, id] : form.profileIds.filter((p) => p !== id));

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(160px,1fr)_minmax(140px,1fr)_auto] gap-2 items-end">
        <Field label="CIDR or IP">
          <Input
            aria-label="CIDR"
            className="font-mono"
            placeholder="192.168.1.0/24"
            value={form.cidr}
            onChange={(e) => set("cidr", e.target.value)}
            disabled={disabled}
          />
        </Field>
        <Field label="Label">
          <Input
            aria-label="Label"
            placeholder="Office LAN"
            value={form.label}
            onChange={(e) => set("label", e.target.value)}
            disabled={disabled}
          />
        </Field>
        <Field label="Interval (empty = default)">
          <div className="flex gap-1.5">
            <div className="w-[84px]">
              <Input
                aria-label="Interval"
                type="number"
                min={1}
                placeholder="default"
                value={form.interval}
                onChange={(e) => set("interval", e.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="w-[80px]">
              <Select
                aria-label="Interval unit"
                value={form.unit}
                onChange={(e) => set("unit", e.target.value as IntervalUnit)}
                disabled={disabled}
              >
                <option value="min">min</option>
                <option value="sec">sec</option>
              </Select>
            </div>
          </div>
        </Field>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-muted select-none">SNMP profiles (none selected = all profiles)</span>
        {profiles.length === 0 ? (
          <span className="text-muted text-[10px] opacity-70">No SNMP profiles defined; all credentials are tried.</span>
        ) : (
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {profiles.map((p) => (
              <label key={p.id} className="inline-flex items-center gap-1.5 text-[11px] text-primary cursor-pointer">
                <input
                  type="checkbox"
                  id={`${idPrefix}-profile-${p.id}`}
                  className="accent-accent"
                  checked={form.profileIds.includes(p.id)}
                  onChange={(e) => toggleProfile(p.id, e.target.checked)}
                  disabled={disabled}
                />
                {p.label}
              </label>
            ))}
          </div>
        )}
      </div>
      <label className="inline-flex items-center gap-1.5 text-[11px] text-primary cursor-pointer">
        <input
          type="checkbox"
          className="accent-accent"
          checked={form.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
          disabled={disabled}
        />
        Enabled
      </label>
      {error && <div className="text-danger text-[11px]">{error}</div>}
    </div>
  );
}

const RANGE_SCAN_POLL = { intervalMs: 2000, maxErrors: 5, maxDurationMs: 30 * 60_000 };

function DiscoveryRanges() {
  const canEdit = (getStoredUser()?.role ?? "viewer") !== "viewer";
  const { data: ranges = [], isLoading } = useScanRanges();
  const { data: profiles = [] } = useSnmpProfiles();
  const { addToast } = useToast();
  const { invalidate } = useInvalidateApi();

  const [addForm, setAddForm] = useState<RangeForm>(EMPTY_FORM);
  const [addError, setAddError] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<RangeForm>(EMPTY_FORM);
  const [editError, setEditError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ScanRange | null>(null);
  const [activeJob, setActiveJob] = useState<{ jobId: string; label: string } | null>(null);

  // Track the most recent manual scan so the range list refreshes (last /
  // next scan, host count) once it ends.
  const { finished, error: pollError, timedOut } = useScanJob<unknown>(activeJob?.jobId ?? null, RANGE_SCAN_POLL);
  useEffect(() => {
    if (!activeJob || (!finished && !pollError && !timedOut)) return;
    invalidate(
      queryKeys.scanRanges,
      queryKeys.scanRuns,
      queryKeys.credentials,
      queryKeys.pingCandidates(),
      queryKeys.topology,
      queryKeys.devices,
      queryKeys.stats,
    );
    if (finished) addToast(`Range scan finished: ${activeJob.label}`, "success");
    setActiveJob(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, pollError, timedOut]);

  const onJobStarted = (job: ScanRangeJob, label: string) => {
    addToast(`Range scan ${job.status}: ${label} (job ${job.job_id})`, "info");
    setActiveJob({ jobId: job.job_id, label });
  };

  const createMutation = useCreateScanRange({
    onSuccess: (created) => {
      setAddForm(EMPTY_FORM);
      addToast(`Range ${created?.cidr ?? ""} added`.trim(), "success");
    },
    onError: (ex) => setAddError(extractErrorMessage(ex)),
  });
  const updateMutation = useUpdateScanRange({
    onError: (ex) => addToast(extractErrorMessage(ex), "error"),
  });
  const deleteMutation = useDeleteScanRange({
    onSuccess: () => setDeleteTarget(null),
    onError: (ex) => addToast(extractErrorMessage(ex), "error"),
  });
  const scanNowMutation = useScanRangeNow({
    onError: (ex) => addToast(`Range scan failed: ${extractErrorMessage(ex)}`, "error"),
  });
  const scanAllMutation = useScanAllRanges({
    onSuccess: (job) => onJobStarted(job, "all enabled ranges"),
    onError: (ex) => addToast(`Range scan failed: ${extractErrorMessage(ex)}`, "error"),
  });

  const submitAdd = () => {
    setAddError("");
    const { payload, error } = formToPayload(addForm);
    if (error) {
      setAddError(error);
      return;
    }
    createMutation.mutate(payload);
  };

  const startEdit = (range: ScanRange) => {
    setEditingId(range.id);
    setEditForm(formFromRange(range));
    setEditError("");
  };

  const submitEdit = () => {
    if (editingId == null) return;
    setEditError("");
    const { payload, error } = formToPayload(editForm);
    if (error) {
      setEditError(error);
      return;
    }
    updateMutation.mutate(
      { id: editingId, patch: payload },
      {
        onSuccess: () => setEditingId(null),
        onError: (ex) => setEditError(extractErrorMessage(ex)),
      },
    );
  };

  const toggleEnabled = (range: ScanRange) => {
    updateMutation.mutate({ id: range.id, patch: { enabled: !range.enabled } });
  };

  const scanNow = (range: ScanRange) => {
    scanNowMutation.mutate(range.id, { onSuccess: (job) => onJobStarted(job, range.label || range.cidr) });
  };

  const enabledCount = ranges.filter((r) => r.enabled).length;
  const th = "px-2 py-1.5 text-left text-[10px] font-semibold text-muted tracking-[1px] select-none whitespace-nowrap";
  const td = "px-2 py-1.5 text-[11px] text-primary align-middle";

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted text-[10px] leading-relaxed">
        Each range is scanned on its own schedule (its interval, otherwise the global discovery interval) or manually
        with Scan now; full and discovery scans no longer probe these ranges. Responding SNMP hosts are added as
        credentials. Hosts that answer ping but not SNMP are re-probed only after the skip window configured under
        Scan engine settings.
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {canEdit && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => scanAllMutation.mutate()}
            disabled={scanAllMutation.isPending || enabledCount === 0}
          >
            {scanAllMutation.isPending ? "Starting..." : "Scan all ranges now"}
          </Button>
        )}
        <span className="text-muted text-[10px] opacity-70">
          {ranges.length} range(s), {enabledCount} enabled
          {activeJob ? ` - scanning ${activeJob.label}...` : ""}
        </span>
      </div>

      {isLoading ? (
        <TabLoading label="Loading ranges..." />
      ) : ranges.length === 0 ? (
        <EmptyState title="No discovery ranges" hint="Add an IP or CIDR range below to discover SNMP devices." />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full border-collapse">
            <thead className="bg-panel-2">
              <tr>
                <th className={th}>CIDR</th>
                <th className={th}>LABEL</th>
                <th className={th}>ENABLED</th>
                <th className={th}>INTERVAL</th>
                <th className={th}>PROFILES</th>
                <th className={th}>HOSTS</th>
                <th className={th}>LAST SCAN</th>
                <th className={th}>NEXT SCAN</th>
                <th className={th}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {ranges.map((range) =>
                editingId === range.id ? (
                  <tr key={range.id} className="border-t border-line" data-testid={`scan-range-${range.id}`}>
                    <td className={td} colSpan={9}>
                      <RangeFields
                        idPrefix={`edit-${range.id}`}
                        form={editForm}
                        onChange={setEditForm}
                        profiles={profiles}
                        disabled={updateMutation.isPending}
                        error={editError}
                      />
                      <div className="flex gap-2 mt-2">
                        <Button size="sm" variant="primary" onClick={submitEdit} disabled={updateMutation.isPending}>
                          {updateMutation.isPending ? "Saving..." : "Save"}
                        </Button>
                        <Button size="sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={range.id} className="border-t border-line" data-testid={`scan-range-${range.id}`}>
                    <td className={`${td} font-mono text-accent whitespace-nowrap`}>{range.cidr}</td>
                    <td className={td}>{range.label || "-"}</td>
                    <td className={td}>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          className="accent-accent"
                          aria-label={`Enable ${range.cidr}`}
                          checked={range.enabled}
                          onChange={() => toggleEnabled(range)}
                          disabled={!canEdit || updateMutation.isPending}
                        />
                        <Badge tone={range.enabled ? "success" : "neutral"}>{range.enabled ? "on" : "off"}</Badge>
                      </label>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{formatInterval(range.interval_sec)}</td>
                    <td className={td}>{profileSummary(range.profile_ids, profiles)}</td>
                    <td className={`${td} tabular-nums`}>{range.host_count ?? 0}</td>
                    <td className={`${td} whitespace-nowrap`}>{formatTimestamp(range.last_scan_at)}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      {range.enabled ? formatTimestamp(range.next_scan_at) : "-"}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {canEdit ? (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            onClick={() => scanNow(range)}
                            disabled={scanNowMutation.isPending}
                            aria-label={`Scan ${range.cidr} now`}
                          >
                            Scan now
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => startEdit(range)} aria-label={`Edit ${range.cidr}`}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => setDeleteTarget(range)}
                            aria-label={`Delete ${range.cidr}`}
                          >
                            Delete
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted">-</span>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <div className="p-3 rounded-card bg-surface border border-line flex flex-col gap-2" data-testid="scan-range-add">
          <div className="text-[10px] font-bold tracking-[1px] text-muted select-none">ADD RANGE</div>
          <RangeFields
            idPrefix="add"
            form={addForm}
            onChange={setAddForm}
            profiles={profiles}
            disabled={createMutation.isPending}
            error={addError}
          />
          <div>
            <Button variant="primary" size="sm" onClick={submitAdd} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Adding..." : "Add range"}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDeleteModal
        open={deleteTarget != null}
        title="Delete range"
        message={
          <>
            Delete discovery range <span className="font-mono text-primary">{deleteTarget?.cidr}</span>? Devices and
            credentials already discovered stay untouched.
          </>
        }
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

export default DiscoveryRanges;
