import { Card } from "../../components/ui";

export interface RackStatRow {
  id: number;
  label: string;
  room?: string;
  deviceCount: number;
  totalPorts: number;
  activePorts: number;
}

export function RackOverview({ racks }: { racks: RackStatRow[] }) {
  if (racks.length === 0) return null;
  return (
    <Card title="Racks overview">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider text-muted">Rack</th>
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider text-muted">Room</th>
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider text-muted text-right">Switches</th>
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider text-muted text-right">Ports</th>
              <th className="py-2 text-[10px] font-semibold uppercase tracking-wider text-muted text-right">Active</th>
            </tr>
          </thead>
          <tbody>
            {racks.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="py-2 pr-3 font-semibold text-primary">{r.label}</td>
                <td className="py-2 pr-3 text-muted">{r.room || "-"}</td>
                <td className="py-2 pr-3 text-right text-accent">{r.deviceCount}</td>
                <td className="py-2 pr-3 text-right text-muted">{r.totalPorts}</td>
                <td className="py-2 text-right">
                  <span className={r.activePorts > 0 ? "text-success" : "text-muted"}>{r.activePorts}</span>
                  <span className="text-muted"> / {r.totalPorts}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
