// ── RacksPage ────────────────────────────────────────────────────────────────
// Rack elevation view: pick a rack, see its true U layout, drag devices into
// place. Deep-linkable via /racks?rack={id}.

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getStoredUser } from "../api";
import { useTopology } from "../hooks/api";
import { EmptyState, Select, Spinner } from "../components/ui";
import RackElevation from "../features/racks/RackElevation";
import { rackHeightU } from "../features/racks/rackLayout";

export default function RacksPage() {
  const { data, isLoading, isError, error } = useTopology();
  const [searchParams, setSearchParams] = useSearchParams();

  const racks = useMemo(() => data?.racks ?? [], [data]);
  const nodes = useMemo(() => data?.nodes ?? [], [data]);

  const rackParam = Number(searchParams.get("rack"));
  const activeRack =
    racks.find((r) => r.id === rackParam) ?? racks[0] ?? null;

  const role = getStoredUser()?.role ?? "viewer";
  const readOnly = role === "viewer";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-[13px] gap-2">
        <Spinner size={14} />
        Loading racks...
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        title="Failed to load topology"
        hint={error instanceof Error ? error.message : String(error)}
      />
    );
  }

  if (racks.length === 0) {
    return (
      <EmptyState
        title="No racks defined yet"
        hint="Create racks in the settings first."
        action={
          <Link to="/settings/racks" className="text-accent text-xs hover:underline">
            Manage racks
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pb-6">
      {/* Page header */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-primary text-base font-bold">Racks</h1>
        <div className="w-56">
          <Select
            aria-label="Select rack"
            value={activeRack?.id ?? ""}
            onChange={(e) => setSearchParams({ rack: e.target.value })}
          >
            {racks.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
                {r.room ? ` (${r.room})` : ""} - {rackHeightU(r)}U
              </option>
            ))}
          </Select>
        </div>
        <Link to="/settings/racks" className="text-accent text-[11px] hover:underline ml-auto">
          Manage racks
        </Link>
      </div>

      {activeRack && <RackElevation rack={activeRack} nodes={nodes} readOnly={readOnly} />}
    </div>
  );
}
