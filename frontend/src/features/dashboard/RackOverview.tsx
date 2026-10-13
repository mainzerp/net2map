import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";

export interface RackStatRow {
  id: number;
  label: string;
  room?: string;
  // "Building / Floor" when the rack is assigned to a floor.
  floor?: string | null;
  deviceCount: number;
  totalPorts: number;
  activePorts: number;
}

// Quiet rack table: one row per rack with a slim port-utilization bar.
export function RackOverview({ racks }: { racks: RackStatRow[] }) {
  const navigate = useNavigate();
  if (racks.length === 0) return null;
  const showFloor = racks.some((r) => r.floor);
  return (
    <section
      aria-labelledby="racks-heading"
      className="bg-panel border border-line rounded-card shadow-card overflow-hidden"
    >
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-3">
        <h2 id="racks-heading" className="m-0 text-sm font-semibold text-primary">
          Racks overview
        </h2>
        <button
          type="button"
          onClick={() => navigate("/racks")}
          className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-accent cursor-pointer bg-transparent border-0 p-0"
        >
          Open racks
          <ArrowRight size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="border-y border-line text-left bg-panel-2/50">
              <th className="py-2 pl-5 pr-3 text-[10px] font-semibold uppercase tracking-wider text-muted">Rack</th>
              {showFloor && (
                <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider text-muted">Building / Floor</th>
              )}
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider text-muted">Room</th>
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider text-muted text-right">Switches</th>
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider text-muted text-right">Ports</th>
              <th className="py-2 pr-5 text-[10px] font-semibold uppercase tracking-wider text-muted text-right w-48">Active</th>
            </tr>
          </thead>
          <tbody>
            {racks.map((r) => {
              const pct = r.totalPorts > 0 ? Math.round((r.activePorts / r.totalPorts) * 100) : 0;
              return (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="py-2.5 pl-5 pr-3 font-semibold text-primary">{r.label}</td>
                  {showFloor && <td className="py-2.5 pr-3 text-muted">{r.floor || "-"}</td>}
                  <td className="py-2.5 pr-3 text-muted">{r.room || "-"}</td>
                  <td className="py-2.5 pr-3 text-right text-primary">{r.deviceCount}</td>
                  <td className="py-2.5 pr-3 text-right text-muted">{r.totalPorts}</td>
                  <td className="py-2.5 pr-5">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-20 h-1 rounded-full bg-panel-2 overflow-hidden" aria-hidden="true">
                        <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-primary">{r.activePorts}</span>
                      <span className="text-muted">/ {r.totalPorts}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
