// ── RacksPage ────────────────────────────────────────────────────────────────
// Rack elevation view: pick a rack, see its true U layout, drag devices into
// place. Deep-linkable via /racks?rack={id}.

import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Activity, Pencil, Plus } from "lucide-react";
import { getStoredUser } from "../api";
import { useTopology } from "../hooks/api";
import { Button, EmptyState, Select, Spinner } from "../components/ui";
import RackElevation from "../features/racks/RackElevation";
import RackFormModal from "../features/racks/RackFormModal";
import { findFloor } from "../features/topology/floors";
import type { RackInfo } from "../types";
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
  // Admins and operators may create and edit racks here; viewers only look.
  const canEdit = !readOnly;

  // Rack dialog: "new" creates, a rack edits it; null is closed.
  const [form, setForm] = useState<{ rack: RackInfo | null } | null>(null);

  const selectRack = (id: number) =>
    // Keep other params (e.g. the inspector drawer target) intact.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("rack", String(id));
      return next;
    });

  const rackForm = form && (
    <RackFormModal
      open
      rack={form.rack}
      onClose={() => setForm(null)}
      onSaved={(saved) => {
        if (form.rack == null) selectRack(saved.id);
      }}
    />
  );

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
      <>
        <EmptyState
          title="No racks defined yet"
          hint="A rack is a physical cabinet on a floor. Create one, then drag devices into it here."
          action={
            <div className="flex items-center gap-3">
              {canEdit && (
                <Button size="sm" variant="primary" onClick={() => setForm({ rack: null })}>
                  <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
                  New rack
                </Button>
              )}
              <Link to="/settings/racks" className="text-accent text-xs hover:underline">
                All racks in Settings
              </Link>
            </div>
          }
        />
        {rackForm}
      </>
    );
  }

  const activeFloor = activeRack ? findFloor(data?.buildings, activeRack.floor_id) : null;
  const rackFacts = activeRack
    ? [
        activeRack.room ? `Room ${activeRack.room}` : "No room",
        activeFloor ? `${activeFloor.building.label} / ${activeFloor.floor.label}` : "No floor",
        `${rackHeightU(activeRack)}U`,
      ]
    : [];

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pb-6">
      {/* Page header */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-primary text-base font-bold">Racks</h1>
        <div className="w-56">
          <Select
            aria-label="Select rack"
            value={activeRack?.id ?? ""}
            onChange={(e) => selectRack(Number(e.target.value))}
          >
            {racks.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
                {r.room ? ` (${r.room})` : ""} - {rackHeightU(r)}U
              </option>
            ))}
          </Select>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => setForm({ rack: null })}>
              <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
              New rack
            </Button>
            {activeRack && (
              <Button size="sm" onClick={() => setForm({ rack: activeRack })}>
                <Pencil size={12} strokeWidth={1.75} aria-hidden="true" />
                Edit rack
              </Button>
            )}
          </div>
        )}
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
            All racks in Settings
          </Link>
        </div>
      </div>

      {activeRack && (
        <div className="-mt-2 text-muted text-[11px]" data-testid="rack-header-facts">
          {rackFacts.join(" - ")}
        </div>
      )}

      {activeRack && (
        <RackElevation
          rack={activeRack}
          nodes={nodes}
          readOnly={readOnly}
          activity={activityPref.active}
          classes={data?.classes}
        />
      )}
      {rackForm}
    </div>
  );
}
