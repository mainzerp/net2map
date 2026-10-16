import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { extractErrorMessage } from "../../api";
import type { RackInfo, TopologyNode } from "../../types";
import { useBuildings, useDeleteRack, useDevices, useRacks, useUpdateDeviceMeta } from "../../hooks/api";
import { findFloor, flattenFloors } from "../../features/topology/floors";
import RackFormModal from "../../features/racks/RackFormModal";
import { Button, Card, EmptyState } from "../ui";
import { ConfirmDeleteModal, DeviceAssignment, TabLoading } from "./shared";

// ── RacksTabContent ──────────────────────────────────────────────────────────
interface EditState {
  rack: RackInfo | null;
  open: boolean;
}

interface RacksTabContentProps {
  newEntryTrigger: number;
}

const DEFAULT_RACK_U = 42;

/** Placement summary of one rack: placed/unplaced device counts and used U. */
export function rackUsage(rack: RackInfo, devices: TopologyNode[]) {
  const inRack = devices.filter((d) => d.rack_id === rack.id);
  const placed = inRack.filter((d) => d.rack_u_position != null);
  const usedU = placed.reduce((sum, d) => sum + Math.max(1, d.u_height ?? 1), 0);
  return {
    placed: placed.length,
    unplaced: inRack.length - placed.length,
    usedU,
    totalU: rack.height_u ?? DEFAULT_RACK_U,
  };
}

function RacksTabContent({ newEntryTrigger }: RacksTabContentProps) {
  const { data: racks = [], isLoading } = useRacks();
  const { data: devicesRaw } = useDevices();
  const { data: buildings = [] } = useBuildings();
  const hasFloors = flattenFloors(buildings).length > 0;

  const devices: TopologyNode[] = Array.isArray(devicesRaw) ? devicesRaw : [];

  const [editState, setEditState] = useState<EditState>({ rack: null, open: false });
  const [deleteTarget, setDeleteTarget] = useState<RackInfo | null>(null);
  // Last failed assign/unassign, per rack card.
  const [assignError, setAssignError] = useState<{ rackId: number; message: string } | null>(null);

  useEffect(() => {
    if (newEntryTrigger > 0) setEditState({ rack: null, open: true });
  }, [newEntryTrigger]);

  const closeForm = () => setEditState({ rack: null, open: false });

  const deleteMutation = useDeleteRack({
    onSuccess: () => setDeleteTarget(null),
  });

  const assignMutation = useUpdateDeviceMeta();
  // Assign (rack id) or unassign (null) a device from the card of `cardRackId`;
  // a failure is shown under that card's picker.
  const setDeviceRack = (cardRackId: number, devId: number, rackId: number | null) => {
    setAssignError(null);
    assignMutation.mutate(
      { id: String(devId), patch: { rack_id: rackId } },
      {
        onError: (ex) =>
          setAssignError({
            rackId: cardRackId,
            message: `${rackId == null ? "Unassign" : "Assign"} failed: ${extractErrorMessage(ex)}`,
          }),
      },
    );
  };

  return (
    <div className="flex-1 overflow-y-auto pt-5">
      {/* New / edit rack dialog */}
      <RackFormModal open={editState.open} rack={editState.rack} onClose={closeForm} />

      <ConfirmDeleteModal
        open={deleteTarget != null}
        title="Delete Rack"
        message={deleteTarget ? `Delete rack "${deleteTarget.label}"? Assigned devices are unassigned, not deleted.` : ""}
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Card grid listing */}
      {isLoading ? (
        <TabLoading />
      ) : racks.length === 0 ? (
        <EmptyState
          title="No racks defined yet"
          hint="A rack is a physical cabinet on a floor. Create one with the New rack button above, then place devices in it on the Racks page."
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
          {racks.map((rack) => {
            const assigned = devices.filter((d) => d.rack_id === rack.id);
            const available = devices.filter((d) => d.rack_id == null && !d.ignored);
            const floor = findFloor(buildings, rack.floor_id);
            const usage = rackUsage(rack, devices);
            return (
              <Card key={rack.id}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-primary font-semibold text-[13px] truncate">{rack.label}</span>
                      <span className="text-[10px] text-muted">{rack.height_u ?? DEFAULT_RACK_U}U</span>
                    </div>
                    {(rack.room || rack.description) && (
                      <div className="text-muted text-[10px] mt-0.5">
                        {rack.room}{rack.room && rack.description ? " - " : ""}{rack.description}
                      </div>
                    )}
                    {hasFloors && (
                      <div className="text-muted text-[10px] mt-0.5" data-testid={`rack-floor-${rack.id}`}>
                        {floor ? `${floor.building.label} / ${floor.floor.label}` : "No floor assigned"}
                      </div>
                    )}
                    <div
                      className="text-muted text-[10px] mt-0.5 tabular-nums"
                      data-testid={`rack-usage-${rack.id}`}
                      title="Counts devices only; rack items such as patch panels are not included"
                    >
                      {usage.placed} placed, {usage.unplaced} unplaced, {usage.usedU}/{usage.totalU} U used
                    </div>
                    {usage.unplaced > 0 && (
                      <Link
                        to={`/racks?rack=${rack.id}`}
                        className="inline-block text-accent text-[10px] mt-0.5 hover:underline"
                      >
                        Place {usage.unplaced} unplaced
                      </Link>
                    )}
                  </div>
                  <div className="flex gap-1.5 shrink-0 items-center">
                    <Link
                      to={`/racks?rack=${rack.id}`}
                      className="text-accent text-[10px] hover:underline whitespace-nowrap"
                    >
                      Open elevation
                    </Link>
                    <Button size="sm" onClick={() => setEditState({ rack, open: true })}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleteTarget(rack)}>Delete</Button>
                  </div>
                </div>
                <DeviceAssignment
                  assigned={assigned}
                  available={available}
                  onAssign={(devId) => setDeviceRack(rack.id, devId, rack.id)}
                  onUnassign={(devId) => setDeviceRack(rack.id, devId, null)}
                  hint="Adds the device to this rack without a U position; place it on the Racks page."
                  error={assignError?.rackId === rack.id ? assignError.message : undefined}
                />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default RacksTabContent;
