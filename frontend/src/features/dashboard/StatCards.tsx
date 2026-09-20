import { useNavigate } from "react-router-dom";

interface StatCardsProps {
  switchCount: number;
  downCount: number;
  unassignedCount: number;
  activePorts: number;
  totalPorts: number;
  linkCount: number;
  rackCount: number;
  endpointCount: number | null;
}

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClass?: string;
  to: string;
}

function StatCard({ label, value, sub, valueClass = "text-primary", to }: StatCardProps) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="text-left bg-panel border border-line rounded-lg p-4 hover:border-accent transition-colors cursor-pointer"
    >
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-2xl font-bold leading-tight mt-1 ${valueClass}`}>{value}</div>
      {sub != null && <div className="text-[11px] text-muted mt-1">{sub}</div>}
    </button>
  );
}

export function StatCards({
  switchCount,
  downCount,
  unassignedCount,
  activePorts,
  totalPorts,
  linkCount,
  rackCount,
  endpointCount,
}: StatCardsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      <StatCard
        label="Switches"
        value={switchCount}
        valueClass="text-accent"
        sub={unassignedCount > 0 ? `${unassignedCount} unassigned` : "managed devices"}
        to="/network"
      />
      <StatCard
        label="Switches down"
        value={downCount}
        valueClass={downCount > 0 ? "text-danger" : "text-success"}
        sub={downCount > 0 ? "unreachable" : "all reachable"}
        to="/network?status=down"
      />
      <StatCard
        label="Ports"
        value={
          <>
            {activePorts}
            <span className="text-sm font-normal text-muted"> / {totalPorts}</span>
          </>
        }
        sub={totalPorts > 0 ? `${Math.round((activePorts / totalPorts) * 100)}% active` : "no ports"}
        to="/network"
      />
      <StatCard label="Links" value={linkCount} valueClass="text-success" sub="switch-to-switch" to="/map" />
      <StatCard label="Racks" value={rackCount} sub="defined" to="/map" />
      <StatCard
        label="Endpoints"
        value={endpointCount ?? "-"}
        valueClass="text-accent"
        sub="discovered devices"
        to="/devices"
      />
    </div>
  );
}
