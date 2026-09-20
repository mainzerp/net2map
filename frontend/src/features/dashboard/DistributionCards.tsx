import { Card } from "../../components/ui";
import { VENDOR_ICON, VENDOR_LABEL } from "../../theme/visual";

function Bar({ pct, barClass }: { pct: number; barClass: string }) {
  return (
    <div className="h-1.5 rounded bg-panel-2 overflow-hidden">
      <div
        className={`h-full rounded transition-[width] duration-300 ${barClass}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function VendorDistribution({ vendors, total }: { vendors: Record<string, number>; total: number }) {
  const entries = Object.entries(vendors).sort((a, b) => b[1] - a[1]);
  return (
    <Card title="Vendor breakdown" className="h-full">
      {entries.length === 0 ? (
        <div className="text-xs text-muted">No switches discovered</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {entries.map(([vendor, count]) => {
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={vendor}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-primary flex items-center gap-1.5">
                    <span className="text-[9px] font-bold text-muted">{VENDOR_ICON[vendor] || "[--]"}</span>
                    {VENDOR_LABEL[vendor] || vendor}
                  </span>
                  <span className="text-[11px] text-muted">
                    {count} ({Math.round(pct)}%)
                  </span>
                </div>
                <Bar pct={pct} barClass="bg-accent" />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// Token-based bar color per speed tier (mirrors the intent of speedColor).
function speedBarClass(label: string): string {
  if (label === "100G" || label === "40G" || label === "25G") return "bg-accent";
  if (label === "10G") return "bg-success";
  if (label === "1G") return "bg-warning";
  return "bg-muted";
}

export function LinkSpeedDistribution({ speeds, total }: { speeds: Record<string, number>; total: number }) {
  const entries = Object.entries(speeds).sort((a, b) => b[1] - a[1]);
  return (
    <Card title="Link speeds" className="h-full">
      {entries.length === 0 ? (
        <div className="text-xs text-muted">No links discovered</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {entries.map(([speed, count]) => {
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={speed}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-primary">{speed}</span>
                  <span className="text-[11px] text-muted">
                    {count} links ({Math.round(pct)}%)
                  </span>
                </div>
                <Bar pct={pct} barClass={speedBarClass(speed)} />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
