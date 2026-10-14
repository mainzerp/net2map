import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, normPort, extractErrorMessage, getStoredUser } from "../api";
import { useToast } from "./ToastProvider";
import useNet2MapStore from "../store";
import { useAdoptPingOnly, useEndpoints, useInvalidateApi } from "../hooks/api";
import { queryKeys } from "../hooks/api";
import { Button, Card, DataTable, Input, type DataTableColumn } from "./ui";
import { formatTimestamp } from "../utils/datetime";
import { useInspector } from "../hooks/useInspector";
import type { Endpoint } from "../types";

export default function EndpointTable() {
  const navigate = useNavigate();
  const setHighlightPortKey = useNet2MapStore((s) => s.setHighlightPortKey);
  const endpointsQuery = useEndpoints();
  const { invalidate } = useInvalidateApi();
  const { open: openInspector } = useInspector();

  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string | number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const { addToast } = useToast();
  const canEdit = (getStoredUser()?.role ?? "viewer") !== "viewer";
  const adoptMutation = useAdoptPingOnly();

  // Search lives in the URL so dashboard deep links (?q=) work.
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const setSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value);
    else next.delete("q");
    setSearchParams(next, { replace: true });
  };

  const endpoints: Endpoint[] = useMemo(
    () => (Array.isArray(endpointsQuery.data) ? endpointsQuery.data : []),
    [endpointsQuery.data],
  );

  const toggleIgnored = async (ep: Endpoint) => {
    setTogglingId(ep.id);
    try {
      await api.patch(`/api/endpoints/${ep.id}`, { ignored: !ep.ignored });
      invalidate(queryKeys.endpoints);
    } catch (ex) {
      addToast(`Failed to update endpoint: ${extractErrorMessage(ex)}`, "error");
    } finally {
      setTogglingId(null);
    }
  };

  const bulkIgnore = async (ignored: boolean) => {
    setBulkLoading(true);
    try {
      await api.patch("/api/endpoints/bulk", {
        endpoint_ids: [...selected],
        ignored,
      });
      setSelected(new Set());
      invalidate(queryKeys.endpoints);
    } catch (ex) {
      addToast(`Failed to update endpoints: ${extractErrorMessage(ex)}`, "error");
    } finally {
      setBulkLoading(false);
    }
  };

  // Selected endpoints that can be adopted (an IP is required).
  const adoptable = useMemo(
    () => endpoints.filter((e) => selected.has(e.id) && !!e.ip?.trim()),
    [endpoints, selected],
  );

  const bulkAdoptPingOnly = () => {
    if (adoptable.length === 0) return;
    const entries = adoptable.map((e) => {
      const label = e.hostname?.trim() || "";
      const ip = (e.ip as string).trim();
      return label ? { ip, label } : { ip };
    });
    adoptMutation.mutate(entries, {
      onSuccess: (result) => {
        setSelected(new Set());
        const added = result.created.length;
        const skipped = result.skipped.length;
        addToast(`${added} added, ${skipped} skipped`, added > 0 ? "success" : "warning");
      },
      onError: (ex) => addToast(`Failed to add ping-only devices: ${extractErrorMessage(ex)}`, "error"),
    });
  };

  const goToPort = (ep: Endpoint) => {
    const fo = ep.found_on?.[0];
    if (!fo) return;
    const portKey = `${fo.switch_ip}:${normPort(fo.port_name || "")}`;
    setHighlightPortKey(portKey);
    navigate("/map");
  };

  const searchText = (ep: Endpoint) =>
    [
      ep.mac || "",
      ep.ip || "",
      ep.hostname || "",
      ep.notes || "",
      ...ep.found_on.map((fo) => `${fo.switch_name} ${fo.switch_ip} ${fo.port_name}`),
    ]
      .join(" ")
      .toLowerCase();

  // Memoized so the row array identity is stable across unrelated renders.
  const active = useMemo(() => endpoints.filter((e) => !e.ignored), [endpoints]);
  const ignored = useMemo(() => endpoints.filter((e) => e.ignored), [endpoints]);

  const columns: DataTableColumn<Endpoint>[] = [
    {
      key: "mac",
      header: "MAC",
      sortable: true,
      sortValue: (e) => (e.mac || "").toLowerCase(),
      render: (e) => (
        <span className={`font-mono font-semibold ${e.ignored ? "text-muted" : "text-primary"}`}>{e.mac}</span>
      ),
    },
    {
      key: "ip",
      header: "IP",
      sortable: true,
      sortValue: (e) => e.ip || "",
      render: (e) => <span className="font-mono text-muted">{e.ip || "-"}</span>,
    },
    {
      key: "hostname",
      header: "Hostname",
      sortable: true,
      sortValue: (e) => (e.hostname || "").toLowerCase(),
      render: (e) => <span className="text-muted">{e.hostname || "-"}</span>,
    },
    {
      key: "first_seen",
      header: "First Seen",
      sortable: true,
      sortValue: (e) => e.first_seen || "",
      render: (e) => <span className="text-muted">{formatTimestamp(e.first_seen)}</span>,
    },
    {
      key: "last_seen",
      header: "Last Seen",
      sortable: true,
      sortValue: (e) => e.last_seen || "",
      render: (e) => <span className="text-muted">{formatTimestamp(e.last_seen)}</span>,
    },
    {
      key: "port",
      header: "Found On",
      sortable: true,
      sortValue: (e) => {
        const fo = e.found_on?.[0];
        return fo ? `${fo.switch_name || fo.switch_ip}:${fo.port_name}`.toLowerCase() : "";
      },
      render: (e) => {
        const fo = e.found_on?.[0];
        if (!fo || !fo.switch_ip) return <span className="text-muted">-</span>;
        return (
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              goToPort(e);
            }}
            title={`Found on ${fo.switch_name || fo.switch_ip} port ${fo.port_name} - show on map`}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-line-strong bg-panel-2 text-[10px] text-accent hover:border-accent cursor-pointer"
          >
            {fo.switch_name || fo.switch_ip}:{fo.port_name}
          </button>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      render: (e) => {
        const isToggling = togglingId === e.id;
        return (
          <Button
            variant={e.ignored ? "primary" : "danger"}
            size="sm"
            disabled={isToggling}
            onClick={() => toggleIgnored(e)}
            title={e.ignored ? "Re-enable this endpoint" : "Ignore this endpoint"}
          >
            {isToggling ? "..." : e.ignored ? "Re-enable" : "Ignore"}
          </Button>
        );
      },
    },
  ];

  return (
    <div className="max-w-[1400px] mx-auto flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-primary">Devices</h1>
        <p className="text-xs text-muted mt-0.5">End devices discovered on the network (not managed network devices)</p>
      </div>

      {endpointsQuery.isError ? (
        <Card>
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="text-sm text-danger">
              Failed to load endpoints: {extractErrorMessage(endpointsQuery.error)}
            </div>
            <Button variant="secondary" size="sm" onClick={() => void endpointsQuery.refetch()}>
              Retry
            </Button>
          </div>
        </Card>
      ) : endpointsQuery.isLoading ? (
        <DataTable columns={columns} rows={[]} rowKey={(e: Endpoint) => e.id} loading skeletonRows={6} />
      ) : endpoints.length === 0 ? (
        <Card>
          <div className="text-center text-xs text-muted py-6">No endpoint devices discovered yet</div>
        </Card>
      ) : (
        <>
          <p className="text-[11px] text-muted">
            Ignored endpoints are excluded from display. They remain in the database and can be re-enabled at any time.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search endpoints..."
              aria-label="Search endpoints"
              className="max-w-xs"
            />
          </div>

          {/* Bulk action toolbar */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-panel-2 border border-line-strong rounded-card">
              <span className="text-xs font-semibold text-accent">{selected.size} selected</span>
              <Button variant="danger" size="sm" disabled={bulkLoading} onClick={() => bulkIgnore(true)}>
                Ignore Selected
              </Button>
              <Button variant="primary" size="sm" disabled={bulkLoading} onClick={() => bulkIgnore(false)}>
                Re-enable Selected
              </Button>
              {canEdit && (
                <Button
                  size="sm"
                  disabled={adoptable.length === 0 || adoptMutation.isPending}
                  onClick={bulkAdoptPingOnly}
                  title={
                    adoptable.length === 0
                      ? "None of the selected endpoints has an IP address"
                      : `Add ${adoptable.length} endpoint(s) with an IP as ping-only devices`
                  }
                >
                  {adoptMutation.isPending ? "Adding..." : "Adopt as ping-only"}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {/* Active endpoints */}
          <section className="flex flex-col gap-2">
            <h2 className="text-[10px] font-bold tracking-widest text-muted">
              ACTIVE ENDPOINTS ({active.length})
            </h2>
            <DataTable
              columns={columns}
              rows={active}
              rowKey={(e) => e.id}
              selectable
              selectedKeys={selected}
              onSelectionChange={setSelected}
              search={search}
              searchText={searchText}
              onRowClick={(e) => openInspector("endpoint", e.id)}
              emptyTitle={search ? "No endpoints match your search" : "All endpoints are currently ignored"}
            />
          </section>

          {/* Ignored endpoints */}
          {ignored.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[10px] font-bold tracking-widest text-danger">
                IGNORED ENDPOINTS ({ignored.length})
              </h2>
              <DataTable
                columns={columns}
                rows={ignored}
                rowKey={(e) => e.id}
                selectable
                selectedKeys={selected}
                onSelectionChange={setSelected}
                search={search}
                searchText={searchText}
              onRowClick={(e) => openInspector("endpoint", e.id)}
                rowClassName={() => "opacity-60"}
                emptyTitle="No endpoints match your search"
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
