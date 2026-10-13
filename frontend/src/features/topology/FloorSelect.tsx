import type { SelectHTMLAttributes } from "react";
import { Select } from "../../components/ui";
import type { Building } from "../../types";
import { flattenFloors } from "./floors";

// Floor picker grouped by building, plus "None" (unassigned). Used by the
// device/rack inspectors and the Settings > Racks form.

interface FloorSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> {
  buildings: Building[];
  value: number | null | undefined;
  onChange: (floorId: number | null) => void;
}

export default function FloorSelect({ buildings, value, onChange, ...props }: FloorSelectProps) {
  const entries = flattenFloors(buildings);
  const groups = buildings
    .map(b => ({ building: b, floors: entries.filter(e => e.building.id === b.id).map(e => e.floor) }))
    .filter(g => g.floors.length > 0);
  // A stale id (floor deleted meanwhile) still renders as a selectable value.
  const known = value == null || entries.some(e => e.floor.id === value);
  return (
    <Select
      value={value == null ? "" : String(value)}
      onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))}
      {...props}
    >
      <option value="">None</option>
      {!known && <option value={String(value)}>Unknown floor</option>}
      {groups.map(g => (
        <optgroup key={g.building.id} label={g.building.label}>
          {g.floors.map(f => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}
