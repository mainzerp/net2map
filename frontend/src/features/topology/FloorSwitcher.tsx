import { useRef, type KeyboardEvent } from "react";
import { Building2 } from "lucide-react";
import { Select } from "../../components/ui";
import type { Building } from "../../types";
import { UNASSIGNED, flattenFloors, findFloor, type FloorKey } from "./floors";

// ── FloorSwitcher ────────────────────────────────────────────────────────────
// Compact overlay at the top-left of the map: building select (hidden with a
// single building) plus one tab per floor of the selected building, and an
// "Unassigned" tab with a count badge while racks/devices lack a floor.
// Arrow keys move between tabs (roving focus, ARIA tablist pattern).

interface FloorSwitcherProps {
  buildings: Building[];
  active: FloorKey;
  counts: Map<FloorKey, number>;
  unassignedCount: number;
  onChange: (key: FloorKey) => void;
}

export default function FloorSwitcher({ buildings, active, counts, unassignedCount, onChange }: FloorSwitcherProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const entries = flattenFloors(buildings);
  const withFloors = buildings.filter(b => entries.some(e => e.building.id === b.id));
  const activeEntry = typeof active === "number" ? findFloor(buildings, active) : null;
  // The Unassigned pseudo floor keeps the first building's tabs in view.
  const buildingId = activeEntry?.building.id ?? withFloors[0]?.id ?? null;
  const floors = entries.filter(e => e.building.id === buildingId).map(e => e.floor);

  const tabs: { key: FloorKey; label: string; count: number }[] = floors.map(f => ({
    key: f.id,
    label: f.label,
    count: counts.get(f.id) ?? 0,
  }));
  if (unassignedCount > 0) tabs.push({ key: UNASSIGNED, label: "Unassigned", count: unassignedCount });

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].key);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      className="absolute top-2 left-2 z-10 flex items-center gap-1.5 rounded-card border border-line bg-panel px-1.5 py-1 shadow-card max-w-[calc(100%-1rem)]"
      data-testid="floor-switcher"
    >
      <Building2 size={13} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden="true" />
      {withFloors.length > 1 && (
        <Select
          aria-label="Building"
          value={buildingId ?? ""}
          onChange={e => {
            const first = entries.find(entry => entry.building.id === Number(e.target.value));
            if (first) onChange(first.floor.id);
          }}
          className="w-auto max-w-40 py-0.5 text-[11px]"
        >
          {withFloors.map(b => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </Select>
      )}
      <div role="tablist" aria-label="Floor" className="flex items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab, index) => {
          const selected = tab.key === active;
          const unassigned = tab.key === UNASSIGNED;
          return (
            <button
              key={String(tab.key)}
              ref={el => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!selected) onChange(tab.key);
              }}
              onKeyDown={e => handleKeyDown(e, index)}
              title={`${tab.label}: ${tab.count} device${tab.count === 1 ? "" : "s"}`}
              className={`text-[11px] px-2 py-0.5 rounded-control inline-flex items-center gap-1 whitespace-nowrap cursor-pointer select-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                selected ? "bg-panel-2 text-accent font-semibold" : "text-muted hover:text-primary"
              }`}
            >
              {tab.label}
              <span
                className={`rounded-full px-1.5 text-[9px] font-semibold tabular-nums ${
                  unassigned ? "bg-warning-soft text-warning" : "bg-panel-2 text-muted"
                }`}
                data-testid={unassigned ? "unassigned-count" : undefined}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
