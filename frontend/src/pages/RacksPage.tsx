// ── RacksPage ────────────────────────────────────────────────────────────────
// Rack elevation view: pick a rack, see its true U layout, drag devices into
// place. Deep-linkable via /racks?rack={id}.

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Activity } from "lucide-react";
import { getStoredUser } from "../api";
import { useTopology } from "../hooks/api";
import { EmptyState, Select, Spinner } from "../components/ui";
import RackElevation from "../features/racks/RackElevation";
import { rackHeightU } from "../features/racks/rackLayout";
import { useRackActivity } from "../features/racks/useRackActivity";

export default function RacksPage() {
  const { data, isLoading, isError, error } = useTopology();
  const activityPref = useRackActivity();
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
            onChange={(e) =>
              // Keep other params (e.g. the inspector drawer target) intact.
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set("rack", e.target.value);
                return next;
              })
            }
          >
            {racks.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
                {r.room ? ` (${r.room})` : ""} - {rackHeightU(r)}U
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-3 ml-auto">
          {activityPref.available && (
            <button
              type="button"
              data-testid="rack-activity-toggle"
              aria-pressed={activityPref.enabled}
              title="Subtle blink on port LEDs that are up"
              onClick={() => activityPref.setEnabled(!activityPref.enabled)}
              className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-control border text-[11px] cursor-pointer transition-colors duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                activityPref.enabled
                  ? "border-accent text-accent bg-accent-soft"
                  : "border-line-strong text-muted bg-panel hover:text-primary"
              }`}
            >
              <Activity size={12} aria-hidden="true" />
              Activity
            </button>
          )}
          <Link to="/settings/racks" className="text-accent text-[11px] hover:underline">
            Manage racks
          </Link>
        </div>
      </div>

      {activeRack && (
        <RackElevation rack={activeRack} nodes={nodes} readOnly={readOnly} activity={activityPref.active} />
      )}
    </div>
  );
}
