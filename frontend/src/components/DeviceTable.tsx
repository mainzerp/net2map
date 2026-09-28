import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, extractErrorMessage } from "../api";
import { useToast } from "./ToastProvider";
import { useDevices, useRacks, useInvalidateApi } from "../hooks/api";
import { queryKeys } from "../hooks/api";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Input,
  Modal,
  Select,
  StatusDot,
  type DataTableColumn,
  type StatusDotStatus,
} from "./ui";
import { formatTimestamp } from "../utils/datetime";
import type { DeviceTableProps, RackInfo, SwitchClass, SwitchModel, TopologyNode } from "../types";

// /api/devices returns DeviceOut, which adds last_seen to the topology node shape.
type DeviceRow = TopologyNode & { last_seen?: string | null };

interface EditState {
  id: number | null;
  open: boolean;
}

interface FormState {
  rack_id: number | null;
  class_id: number | null;
  model_id: number | null;
}

const EMPTY_FORM: FormState = { rack_id: null, class_id: null, model_id: null };

// Map the dashboard deep-link alias to the stored ping_status value.
function normalizeStatusParam(raw: string): string {
  if (raw === "down") return "offline";
  return raw;
}

function dotStatus(pingStatus: string | undefined): StatusDotStatus {
  if (pingStatus === "online") return "up";
  if (pingStatus === "offline") return "down";
  return "unknown";
}

export default function DeviceTable({ title, subtitle, activeLabel, ignoredLabel, emptyMessage }: DeviceTableProps) {
  const devicesQuery = useDevices();
  const racksQuery = useRacks();
  const classesQuery = useQuery<SwitchClass[]>({
    queryKey: ["switch-classes"],
    queryFn: () => api.get("/api/switch-classes"),
  });
  const modelsQuery = useQuery<SwitchModel[]>({
    queryKey: ["switch-models"],
    queryFn: () => api.get("/api/switch-models"),
  });
  const { invalidate } = useInvalidateApi();

  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string | number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [editState, setEditState] = useState<EditState>({ id: null, open: false });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [err, setErr] = useState("");
  const { addToast } = useToast();

  // Filter state lives in the URL so dashboard deep links (?q=, ?status=) work.
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const statusFilter = normalizeStatusParam(searchParams.get("status") ?? "");

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const devices: DeviceRow[] = useMemo(
    () => (Array.isArray(devicesQuery.data) ? (devicesQuery.data as DeviceRow[]) : []),
    [devicesQuery.data],
  );
  const racks: RackInfo[] = useMemo(() => racksQuery.data ?? [], [racksQuery.data]);
  const classes = useMemo(() => classesQuery.data ?? [], [classesQuery.data]);
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);

  const rackMap = useMemo(() => Object.fromEntries(racks.map((r) => [r.id, r])), [racks]);
  const classMap = useMemo(() => Object.fromEntries(classes.map((c) => [c.id, c])), [classes]);
  const modelMap = useMemo(() => Object.fromEntries(models.map((m) => [m.id, m])), [models]);

  const invalidateDeviceData = () => {
    invalidate(queryKeys.topology, queryKeys.devices, queryKeys.stats);
  };

  const toggleIgnored = async (dev: DeviceRow) => {
    setTogglingId(dev.id);
    try {
      await api.patch(`/api/topology/devices/${dev.id}/meta`, { ignored: !dev.ignored });
      invalidateDeviceData();
    } catch (ex) {
      addToast(`Failed to update device: ${extractErrorMessage(ex)}`, "error");
    } finally {
      setTogglingId(null);
    }
  };

  const bulkIgnore = async (ignored: boolean) => {
    setBulkLoading(true);
    try {
      await api.patch("/api/topology/devices/bulk-meta", {
        device_ids: [...selected],
        ignored,
      });
      setSelected(new Set());
      invalidateDeviceData();
    } catch (ex) {
      addToast(`Failed to update devices: ${extractErrorMessage(ex)}`, "error");
    } finally {
      setBulkLoading(false);
    }
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditState({ id: null, open: false });
    setErr("");
  };

  const startEdit = (dev: DeviceRow) => {
    setForm({
      rack_id: dev.rack_id ?? null,
      class_id: dev.class_id ?? null,
      model_id: dev.model_id ?? null,
    });
    setEditState({ id: dev.id, open: true });
    setErr("");
  };

  const submitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      await api.patch(`/api/topology/devices/${editState.id}/meta`, {
        rack_id: form.rack_id,
        class_id: form.class_id,
        model_id: form.model_id,
      });
      invalidateDeviceData();
      resetForm();
    } catch (ex) {
      setErr(extractErrorMessage(ex));
    }
  };

  const searchText = (dev: DeviceRow) =>
    [
      dev.sys_name || "",
      dev.ip || "",
      dev.mac || "",
      dev.rack_id && rackMap[dev.rack_id] ? rackMap[dev.rack_id].label : "",
      dev.class_id && classMap[dev.class_id] ? classMap[dev.class_id].label : "",
      dev.model_id && modelMap[dev.model_id] ? modelMap[dev.model_id].name : "",
      dev.vendor || "",
      dev.firmware || "",
      dev.location || "",
    ]
      .join(" ")
      .toLowerCase();

  // The status filter applies on top of the DataTable's built-in search.
  // Memoized so the row array identity is stable across unrelated renders.
  const statusFiltered = useMemo(
    () => (statusFilter ? devices.filter((d) => (d.ping_status ?? "unknown") === statusFilter) : devices),
    [devices, statusFilter],
  );
  const active = useMemo(() => statusFiltered.filter((d) => !d.ignored), [statusFiltered]);
  const ignored = useMemo(() => statusFiltered.filter((d) => d.ignored), [statusFiltered]);

  const columns: DataTableColumn<DeviceRow>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      sortValue: (d) => (d.sys_name || d.ip || "").toLowerCase(),
      render: (d) => (
        <div>
          <div className={`font-semibold ${d.ignored ? "text-muted" : "text-primary"}`}>{d.sys_name || d.ip}</div>
          {d.vendor && (
            <div className="text-[10px] text-muted">
              {d.vendor}
              {d.model ? ` - ${d.model}` : ""}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "ip",
      header: "IP",
      sortable: true,
      sortValue: (d) => d.ip || "",
      render: (d) => <span className="font-mono text-muted">{d.ip}</span>,
    },
    {
      key: "mac",
      header: "MAC",
      sortable: true,
      sortValue: (d) => (d.mac || "").toLowerCase(),
      render: (d) => <span className="font-mono text-muted">{d.mac || "-"}</span>,
    },
    {
      key: "rack",
      header: "Rack",
      sortable: true,
      sortValue: (d) => (d.rack_id && rackMap[d.rack_id] ? rackMap[d.rack_id].label : "").toLowerCase(),
      render: (d) =>
        d.rack_id && rackMap[d.rack_id] ? (
          <Badge tone="accent">{rackMap[d.rack_id].label}</Badge>
        ) : (
          <span className="text-muted">-</span>
        ),
    },
    {
      key: "class",
      header: "Class",
      sortable: true,
      sortValue: (d) => (d.class_id && classMap[d.class_id] ? classMap[d.class_id].label : "").toLowerCase(),
      render: (d) => {
        const cls = d.class_id ? classMap[d.class_id] : undefined;
        if (!cls) return <span className="text-muted">-</span>;
        // Class color is user-configured data, so it stays a dynamic inline value.
        return (
          <Badge className="bg-panel-2" style={cls.color ? { color: cls.color, borderColor: cls.color } : undefined}>
            {cls.label}
          </Badge>
        );
      },
    },
    {
      key: "model",
      header: "Model",
      sortable: true,
      sortValue: (d) => (d.model_id && modelMap[d.model_id] ? modelMap[d.model_id].name : "").toLowerCase(),
      render: (d) =>
        d.model_id && modelMap[d.model_id] ? (
          <Badge tone="warning">{modelMap[d.model_id].name}</Badge>
        ) : (
          <span className="text-muted">-</span>
        ),
    },
    {
      key: "firmware",
      header: "Firmware",
      sortable: true,
      sortValue: (d) => (d.firmware ?? "").toLowerCase(),
      render: (d) => <span className="font-mono text-muted">{d.firmware || "-"}</span>,
    },
    {
      key: "location",
      header: "Location",
      sortable: true,
      sortValue: (d) => (d.location ?? "").toLowerCase(),
      render: (d) => <span className="text-muted">{d.location || "-"}</span>,
    },
    {
      key: "last_seen",
      header: "Last Seen",
      sortable: true,
      sortValue: (d) => d.last_seen ?? "",
      render: (d) => <span className="text-muted">{formatTimestamp(d.last_seen)}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      sortValue: (d) => d.ping_status ?? "unknown",
      render: (d) => (
        <span className="inline-flex items-center gap-1.5 text-muted">
          <StatusDot status={dotStatus(d.ping_status)} />
          {d.ping_status ?? "unknown"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      render: (d) => {
        const isToggling = togglingId === d.id;
        return (
          <div className="inline-flex gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => startEdit(d)}>
              Edit
            </Button>
            <Button
              variant={d.ignored ? "primary" : "danger"}
              size="sm"
              disabled={isToggling}
              onClick={() => toggleIgnored(d)}
              title={d.ignored ? "Re-enable this device (scan + show on map)" : "Ignore this device (skip scan, hide from map)"}
            >
              {isToggling ? "..." : d.ignored ? "Re-enable" : "Ignore"}
            </Button>
          </div>
        );
      },
    },
  ];

  const editDevice = devices.find((d) => d.id === editState.id);

  return (
    <div className="max-w-[1400px] mx-auto flex flex-col gap-4">
      {/* Page title */}
      <div>
        <h1 className="text-lg font-bold text-primary">{title}</h1>
        <p className="text-xs text-muted mt-0.5">{subtitle}</p>
      </div>

      {devicesQuery.isError ? (
        <Card>
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="text-sm text-danger">Failed to load devices: {extractErrorMessage(devicesQuery.error)}</div>
            <Button variant="secondary" size="sm" onClick={() => void devicesQuery.refetch()}>
              Retry
            </Button>
          </div>
        </Card>
      ) : devicesQuery.isLoading ? (
        <DataTable columns={columns} rows={[]} rowKey={(d: DeviceRow) => d.id} loading skeletonRows={6} />
      ) : devices.length === 0 ? (
        <Card>
          <div className="text-center text-xs text-muted py-6">{emptyMessage}</div>
        </Card>
      ) : (
        <>
          <p className="text-[11px] text-muted">
            Ignored devices are excluded from scans and hidden from the topology map. They remain in the database and can
            be re-enabled at any time.
          </p>

          {/* Filter bar synced to URL query params */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setParam("q", e.target.value)}
              placeholder="Search devices..."
              aria-label="Search devices"
              className="max-w-xs"
            />
            <Select
              value={statusFilter}
              onChange={(e) => setParam("status", e.target.value)}
              aria-label="Filter by status"
              className="w-auto"
            >
              <option value="">All statuses</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="unknown">Unknown</option>
            </Select>
          </div>

          {/* Bulk action toolbar */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-panel-2 border border-line-strong rounded-lg">
              <span className="text-xs font-semibold text-accent">{selected.size} selected</span>
              <Button variant="danger" size="sm" disabled={bulkLoading} onClick={() => bulkIgnore(true)}>
                Ignore Selected
              </Button>
              <Button variant="primary" size="sm" disabled={bulkLoading} onClick={() => bulkIgnore(false)}>
                Re-enable Selected
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {/* Active devices */}
          <section className="flex flex-col gap-2">
            <h2 className="text-[10px] font-bold tracking-widest text-muted">
              {activeLabel} ({active.length})
            </h2>
            <DataTable
              columns={columns}
              rows={active}
              rowKey={(d) => d.id}
              selectable
              selectedKeys={selected}
              onSelectionChange={setSelected}
              search={search}
              searchText={searchText}
              emptyTitle={search || statusFilter ? "No devices match your filters" : "All devices are currently ignored"}
            />
          </section>

          {/* Ignored devices */}
          {ignored.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[10px] font-bold tracking-widest text-danger">
                {ignoredLabel} ({ignored.length})
              </h2>
              <DataTable
                columns={columns}
                rows={ignored}
                rowKey={(d) => d.id}
                selectable
                selectedKeys={selected}
                onSelectionChange={setSelected}
                search={search}
                searchText={searchText}
                rowClassName={() => "opacity-60"}
                emptyTitle="No devices match your filters"
              />
            </section>
          )}
        </>
      )}

      {/* Edit modal */}
      <Modal open={editState.open} onClose={resetForm} title="Edit device" width={420}>
        <form onSubmit={submitEdit} className="flex flex-col gap-3">
          <div className="px-3 py-2 bg-panel-2 rounded-md border border-line">
            <div className="text-xs font-semibold text-primary">{editDevice ? editDevice.sys_name || editDevice.ip : ""}</div>
            <div className="text-[10px] text-muted">{editDevice?.ip || ""}</div>
          </div>
          <label className="block text-[11px] text-muted select-none">
            Rack
            <Select
              className="mt-1"
              value={form.rack_id ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, rack_id: e.target.value ? +e.target.value : null }))}
            >
              <option value="">-- No rack --</option>
              {racks.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                  {r.room ? ` / ${r.room}` : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-[11px] text-muted select-none">
            Class
            <Select
              className="mt-1"
              value={form.class_id ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, class_id: e.target.value ? +e.target.value : null }))}
            >
              <option value="">-- No class --</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-[11px] text-muted select-none">
            Model
            <Select
              className="mt-1"
              value={form.model_id ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, model_id: e.target.value ? +e.target.value : null }))}
            >
              <option value="">-- No model --</option>
              {[...models].sort((a, b) => a.name.localeCompare(b.name)).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </label>
          {err && <div className="text-xs text-danger">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={resetForm}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
