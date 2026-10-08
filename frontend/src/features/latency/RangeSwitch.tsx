import type { LatencyRange } from "../../types";
import { LATENCY_RANGES } from "./latency";

// Compact segmented control for the history range (1h / 24h / 7d).
export function RangeSwitch({
  value,
  onChange,
  label = "History range",
}: {
  value: LatencyRange;
  onChange: (range: LatencyRange) => void;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex items-center rounded-control border border-line bg-panel overflow-hidden">
      {LATENCY_RANGES.map((range) => {
        const active = range === value;
        return (
          <button
            key={range}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(range);
            }}
            className={`text-[10px] px-2 py-0.5 font-semibold tabular-nums border-l border-line first:border-l-0 cursor-pointer transition-colors duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
              active ? "bg-panel-2 text-accent" : "text-muted hover:text-primary"
            }`}
          >
            {range}
          </button>
        );
      })}
    </div>
  );
}
