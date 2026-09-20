import { useNavigate } from "react-router-dom";
import { Card, StatusDot } from "../../components/ui";
import { formatTimestamp } from "../../utils/datetime";
import type { TopologyNode } from "../../types";

// Lists devices whose last ping failed plus the count of ignored devices.
export function AttentionCard({ nodes }: { nodes: TopologyNode[] }) {
  const navigate = useNavigate();
  const offline = nodes.filter((n) => !n.ignored && n.ping_status === "offline");
  const ignoredCount = nodes.filter((n) => n.ignored).length;

  return (
    <Card title="Attention needed" className="h-full">
      {offline.length === 0 && ignoredCount === 0 ? (
        <div className="flex items-center gap-2 text-xs text-success">
          <StatusDot status="up" />
          All devices reachable
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {offline.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => navigate("/network?status=down")}
              className="flex items-center justify-between gap-2 text-left rounded-md px-2 py-1.5 hover:bg-panel-2 cursor-pointer"
            >
              <span className="flex items-center gap-2 min-w-0">
                <StatusDot status="down" />
                <span className="text-xs font-semibold text-primary truncate">
                  {d.sys_name || d.hostname || d.ip}
                </span>
                <span className="text-[11px] text-muted font-mono">{d.ip}</span>
              </span>
              <span className="text-[10px] text-muted whitespace-nowrap">
                last seen {formatTimestamp(d.last_seen as string | null)}
              </span>
            </button>
          ))}
          {ignoredCount > 0 && (
            <button
              type="button"
              onClick={() => navigate("/network")}
              className="text-left text-[11px] text-muted hover:text-primary px-2 py-1 cursor-pointer"
            >
              {ignoredCount} ignored device{ignoredCount === 1 ? "" : "s"} excluded from scans
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
