import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { extractErrorMessage, getStoredUser } from "../../api";
import type { Building, Floor } from "../../types";
import {
  useBuildings,
  useCreateBuilding,
  useCreateFloor,
  useDeleteBuilding,
  useDeleteFloor,
  useDeleteFloorBackground,
  useUpdateBuilding,
  useUpdateFloor,
  useUploadFloorBackground,
  type FloorPatch,
} from "../../hooks/api";
import { floorBackgroundUrl } from "../../hooks/useMapBackground";
import { useToast } from "../ToastProvider";
import { debounce } from "../../utils/debounce";
import { THEME_MAP_BG_SENTINEL, resolveMapBgColor } from "../../theme/mapBackground";
import { Button, Card, EmptyState, Input } from "../ui";
import { ConfirmDeleteModal, SectionHeader, TabError, TabLoading } from "./shared";

// ── BuildingsFloorsTab ───────────────────────────────────────────────────────
// Settings > Buildings & floors: CRUD for buildings and their floors, ordering
// (sort_order re-numbered via up/down), and the per-floor background image
// with opacity, zoom and canvas color (PATCH /api/floors/{id}). Replaces the
// former global map background settings.

type DeleteTarget = { kind: "building"; item: Building } | { kind: "floor"; item: Floor };

function bySortOrder<T extends { sort_order: number; id: number }>(a: T, b: T): number {
  return a.sort_order - b.sort_order || a.id - b.id;
}

// New sort_order values after moving index `from` by `delta`; only entries
// whose value changes are returned.
function reorder<T extends { id: number; sort_order: number }>(items: T[], from: number, delta: number) {
  const to = from + delta;
  if (to < 0 || to >= items.length) return [];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next
    .map((item, index) => ({ id: item.id, sort_order: index }))
    .filter((entry, index) => next[index].sort_order !== entry.sort_order);
}

function InlineRename({
  value,
  label,
  disabled,
  onSave,
}: {
  value: string;
  label: string;
  disabled: boolean;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (!next) {
      setDraft(value);
      return;
    }
    if (next !== value) onSave(next);
  };
  return (
    <Input
      aria-label={label}
      value={draft}
      disabled={disabled}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
      }}
      className="max-w-64 font-semibold"
    />
  );
}

function OrderButtons({
  name,
  index,
  count,
  disabled,
  onMove,
}: {
  name: string;
  index: number;
  count: number;
  disabled: boolean;
  onMove: (delta: number) => void;
}) {
  return (
    <span className="inline-flex gap-1">
      <Button size="sm" variant="ghost" aria-label={`Move ${name} up`} disabled={disabled || index === 0} onClick={() => onMove(-1)}>
        <ArrowUp size={12} strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Move ${name} down`}
        disabled={disabled || index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </span>
  );
}

function FloorBackgroundPanel({ floor, canEdit }: { floor: Floor; canEdit: boolean }) {
  const { addToast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const updateFloor = useUpdateFloor();
  const upload = useUploadFloorBackground();
  const remove = useDeleteFloorBackground();
  const [draft, setDraft] = useState({ bg_opacity: floor.bg_opacity, bg_scale: floor.bg_scale, bg_color: floor.bg_color });
  useEffect(() => {
    setDraft({ bg_opacity: floor.bg_opacity, bg_scale: floor.bg_scale, bg_color: floor.bg_color });
  }, [floor.id, floor.bg_opacity, floor.bg_scale, floor.bg_color]);

  // Sliders and the color picker fire per tick: merge the changes and send
  // one PATCH after the user pauses.
  const pendingRef = useRef<FloorPatch>({});
  const mutateRef = useRef(updateFloor.mutate);
  mutateRef.current = updateFloor.mutate;
  const flush = useRef(
    debounce((floorId: number) => {
      const patch = pendingRef.current;
      pendingRef.current = {};
      mutateRef.current(
        { id: floorId, ...patch },
        { onError: ex => addToast(`Failed to save floor settings: ${extractErrorMessage(ex)}`, "error") },
      );
    }, 300),
  ).current;

  const change = (patch: FloorPatch) => {
    setDraft(d => ({ ...d, ...patch }));
    pendingRef.current = { ...pendingRef.current, ...patch };
    flush(floor.id);
  };

  const followsTheme = resolveMapBgColor(draft.bg_color) === "";
  const colorValue = followsTheme ? THEME_MAP_BG_SENTINEL : draft.bg_color;

  return (
    <div className="mt-3 rounded-control border border-line bg-panel-2 p-3 flex flex-col gap-4" data-testid={`floor-bg-${floor.id}`}>
      <SectionHeader>BACKGROUND - {floor.label.toUpperCase()}</SectionHeader>
      <div className="flex items-center gap-2.5 flex-wrap">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label={`Background image for ${floor.label}`}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (!file) return;
            upload.mutate(
              { floorId: floor.id, file },
              { onError: ex => addToast(`Upload failed: ${extractErrorMessage(ex)}`, "error") },
            );
            e.target.value = "";
          }}
        />
        {canEdit && (
          <Button onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? "Uploading..." : floor.has_background ? "Replace image" : "Upload image"}
          </Button>
        )}
        {canEdit && floor.has_background && (
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(floor.id, { onError: ex => addToast(`Remove failed: ${extractErrorMessage(ex)}`, "error") })
            }
          >
            Remove image
          </Button>
        )}
        {!floor.has_background && <span className="text-[11px] text-muted">No floor plan uploaded</span>}
      </div>
      {floor.has_background && (
        <div className="rounded-card border border-line overflow-hidden max-w-[400px]">
          <img src={floorBackgroundUrl(floor)} alt={`${floor.label} floor plan preview`} className="block w-full opacity-80" />
        </div>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[11px] text-muted w-20">Canvas color</span>
        <input
          type="color"
          aria-label={`Background color for ${floor.label}`}
          value={colorValue}
          disabled={!canEdit}
          onChange={e => change({ bg_color: e.target.value })}
          className="w-10 h-8 p-0.5 border border-line-strong rounded cursor-pointer bg-transparent"
        />
        <span className="text-muted text-[11px] font-mono min-w-9">{followsTheme ? "theme surface" : draft.bg_color}</span>
        <Button size="sm" disabled={!canEdit || followsTheme} onClick={() => change({ bg_color: THEME_MAP_BG_SENTINEL })}>
          Follow theme
        </Button>
        {/* White is a user data color for floor plans, not UI chrome */}
        <Button size="sm" disabled={!canEdit} onClick={() => change({ bg_color: "#ffffff" })}>
          White
        </Button>
      </div>
      {floor.has_background && (
        <>
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-muted w-20">Opacity</span>
            <input
              type="range"
              aria-label={`Background opacity for ${floor.label}`}
              min="0.05"
              max="1"
              step="0.05"
              value={draft.bg_opacity}
              disabled={!canEdit}
              onChange={e => change({ bg_opacity: parseFloat(e.target.value) })}
              className="w-[200px] accent-accent"
            />
            <span className="text-muted text-[11px] font-mono min-w-9">{Math.round(draft.bg_opacity * 100)}%</span>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-muted w-20">Image zoom</span>
            <input
              type="range"
              aria-label={`Background zoom for ${floor.label}`}
              min="0.1"
              max="5"
              step="0.1"
              value={draft.bg_scale}
              disabled={!canEdit}
              onChange={e => change({ bg_scale: parseFloat(e.target.value) })}
              className="w-[200px] accent-accent"
            />
            <span className="text-muted text-[11px] font-mono min-w-9">{Math.round(draft.bg_scale * 100)}%</span>
          </div>
        </>
      )}
    </div>
  );
}

function BuildingCard({
  building,
  index,
  count,
  canEdit,
  canDelete,
  onMove,
  onDelete,
  onDeleteFloor,
}: {
  building: Building;
  index: number;
  count: number;
  canEdit: boolean;
  canDelete: boolean;
  onMove: (delta: number) => void;
  onDelete: () => void;
  onDeleteFloor: (floor: Floor) => void;
}) {
  const { addToast } = useToast();
  const updateBuilding = useUpdateBuilding();
  const updateFloor = useUpdateFloor();
  const createFloor = useCreateFloor();
  const [newFloor, setNewFloor] = useState("");
  const [openFloorId, setOpenFloorId] = useState<number | null>(null);
  const floors = [...(building.floors ?? [])].sort(bySortOrder);
  const openFloor = floors.find(f => f.id === openFloorId) ?? null;
  const onError = (what: string) => (ex: unknown) => addToast(`${what}: ${extractErrorMessage(ex)}`, "error");

  const moveFloor = (from: number, delta: number) => {
    reorder(floors, from, delta).forEach(({ id, sort_order }) =>
      updateFloor.mutate({ id, sort_order }, { onError: onError("Failed to reorder floors") }),
    );
  };

  const addFloor = (e: React.FormEvent) => {
    e.preventDefault();
    const label = newFloor.trim();
    if (!label) return;
    const sortOrder = floors.length > 0 ? Math.max(...floors.map(f => f.sort_order)) + 1 : 0;
    createFloor.mutate(
      { buildingId: building.id, label, sort_order: sortOrder },
      { onSuccess: () => setNewFloor(""), onError: onError("Failed to create floor") },
    );
  };

  return (
    <Card
      data-testid={`building-${building.id}`}
      title={
        <InlineRename
          value={building.label}
          label={`Building name for ${building.label}`}
          disabled={!canEdit}
          onSave={label => updateBuilding.mutate({ id: building.id, label }, { onError: onError("Failed to rename building") })}
        />
      }
      actions={
        <>
          <OrderButtons name={building.label} index={index} count={count} disabled={!canEdit} onMove={onMove} />
          {canDelete && (
            <Button size="sm" variant="danger" aria-label={`Delete building ${building.label}`} onClick={onDelete}>
              <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          )}
        </>
      }
    >
      {floors.length === 0 ? (
        <div className="text-[11px] text-muted mb-2">No floors yet. Add one below.</div>
      ) : (
        <ul className="flex flex-col gap-1.5 mb-3">
          {floors.map((floor, fi) => (
            <li key={floor.id} className="flex items-center gap-2 flex-wrap">
              <InlineRename
                value={floor.label}
                label={`Floor name for ${floor.label}`}
                disabled={!canEdit}
                onSave={label => updateFloor.mutate({ id: floor.id, label }, { onError: onError("Failed to rename floor") })}
              />
              <span className="text-[10px] text-muted">{floor.has_background ? "floor plan" : "no floor plan"}</span>
              <span className="ml-auto inline-flex items-center gap-1">
                <Button
                  size="sm"
                  variant={openFloorId === floor.id ? "primary" : "secondary"}
                  aria-pressed={openFloorId === floor.id}
                  onClick={() => setOpenFloorId(id => (id === floor.id ? null : floor.id))}
                >
                  Background
                </Button>
                <OrderButtons
                  name={floor.label}
                  index={fi}
                  count={floors.length}
                  disabled={!canEdit}
                  onMove={delta => moveFloor(fi, delta)}
                />
                {canDelete && (
                  <Button size="sm" variant="danger" aria-label={`Delete floor ${floor.label}`} onClick={() => onDeleteFloor(floor)}>
                    <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {openFloor && <FloorBackgroundPanel floor={openFloor} canEdit={canEdit} />}
      {canEdit && (
        <form onSubmit={addFloor} className="flex items-center gap-2 mt-3">
          <Input
            aria-label={`New floor name for ${building.label}`}
            placeholder="e.g. Ground floor"
            value={newFloor}
            onChange={e => setNewFloor(e.target.value)}
            className="max-w-64"
          />
          <Button type="submit" size="sm" disabled={!newFloor.trim() || createFloor.isPending}>
            Add floor
          </Button>
        </form>
      )}
    </Card>
  );
}

function BuildingsFloorsTabContent() {
  const { data: buildingsRaw, isLoading, error } = useBuildings();
  const { addToast } = useToast();
  const createBuilding = useCreateBuilding();
  const updateBuilding = useUpdateBuilding();
  const deleteBuilding = useDeleteBuilding();
  const deleteFloor = useDeleteFloor();
  const [newBuilding, setNewBuilding] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const role = getStoredUser()?.role ?? "viewer";
  const canEdit = role !== "viewer";
  const canDelete = role === "admin";
  const buildings = [...(buildingsRaw ?? [])].sort(bySortOrder);

  const addBuilding = (e: React.FormEvent) => {
    e.preventDefault();
    const label = newBuilding.trim();
    if (!label) return;
    const sortOrder = buildings.length > 0 ? Math.max(...buildings.map(b => b.sort_order)) + 1 : 0;
    createBuilding.mutate(
      { label, sort_order: sortOrder },
      {
        onSuccess: () => setNewBuilding(""),
        onError: ex => addToast(`Failed to create building: ${extractErrorMessage(ex)}`, "error"),
      },
    );
  };

  const moveBuilding = (from: number, delta: number) => {
    reorder(buildings, from, delta).forEach(({ id, sort_order }) =>
      updateBuilding.mutate(
        { id, sort_order },
        { onError: ex => addToast(`Failed to reorder buildings: ${extractErrorMessage(ex)}`, "error") },
      ),
    );
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const opts = {
      onSuccess: () => setDeleteTarget(null),
      onError: (ex: unknown) => addToast(`Delete failed: ${extractErrorMessage(ex)}`, "error"),
    };
    if (deleteTarget.kind === "building") deleteBuilding.mutate(deleteTarget.item.id, opts);
    else deleteFloor.mutate(deleteTarget.item.id, opts);
  };

  const deleteMessage = !deleteTarget
    ? ""
    : deleteTarget.kind === "building"
      ? `Delete building "${deleteTarget.item.label}" and all of its floors? Racks and devices on those floors are not deleted; they become unassigned and show up on the map's "Unassigned" tab.`
      : `Delete floor "${deleteTarget.item.label}" and its floor plan? Racks and devices on this floor are not deleted; they become unassigned and show up on the map's "Unassigned" tab.`;

  return (
    <div className="flex-1 overflow-y-auto pt-5 flex flex-col gap-4 w-full">
      <ConfirmDeleteModal
        open={deleteTarget != null}
        title={deleteTarget?.kind === "building" ? "Delete Building" : "Delete Floor"}
        message={deleteMessage}
        busy={deleteBuilding.isPending || deleteFloor.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <div className="text-[11px] text-muted max-w-2xl">
        Model a site as buildings with floors. Each floor has its own floor plan; the map shows one floor at a time.
        Assign racks (Settings &gt; Racks) and devices outside racks (inspector) to floors. Links to other floors appear
        as portals on the map.
      </div>

      {canEdit && (
        <form onSubmit={addBuilding} className="flex items-center gap-2">
          <Input
            aria-label="New building name"
            placeholder="e.g. Main building"
            value={newBuilding}
            onChange={e => setNewBuilding(e.target.value)}
            className="max-w-64"
          />
          <Button type="submit" variant="primary" size="sm" disabled={!newBuilding.trim() || createBuilding.isPending}>
            Add building
          </Button>
        </form>
      )}

      {isLoading && <TabLoading label="Loading buildings..." />}
      {error && <TabError message={extractErrorMessage(error)} />}
      {!isLoading && !error && buildings.length === 0 && (
        <EmptyState
          title="No buildings defined yet"
          hint="Without buildings the map shows every rack and device on a single canvas without a floor plan."
        />
      )}
      {buildings.map((building, index) => (
        <BuildingCard
          key={building.id}
          building={building}
          index={index}
          count={buildings.length}
          canEdit={canEdit}
          canDelete={canDelete}
          onMove={delta => moveBuilding(index, delta)}
          onDelete={() => setDeleteTarget({ kind: "building", item: building })}
          onDeleteFloor={floor => setDeleteTarget({ kind: "floor", item: floor })}
        />
      ))}
    </div>
  );
}

export default BuildingsFloorsTabContent;
