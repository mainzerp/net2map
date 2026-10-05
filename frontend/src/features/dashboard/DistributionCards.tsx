import { VENDOR_COLOR, VENDOR_ICON, VENDOR_LABEL, speedColor } from "../../theme/visual";

// One compact panel with slim segmented bars for the vendor mix and the
// link-speed mix, colored with the harmonized data palette from theme/visual.

interface Segment {
  key: string;
  label: React.ReactNode;
  count: number;
  color: string;
}

// Representative speed (Mbps) per backend speed_label so the bar reuses
// speedColor() instead of a second color table.
const SPEED_LABEL_MBPS: Record<string, number> = {
  "100G": 100000,
  "40G": 40000,
  "25G": 25000,
  "10G": 10000,
  "1G": 1000,
  "100M": 100,
  "10M": 10,
};

function SegmentedBar({ segments, total, label }: { segments: Segment[]; total: number; label: string }) {
  return (
    <div className="flex h-2 w-full gap-[2px] rounded-full overflow-hidden bg-panel-2" role="img" aria-label={label}>
      {segments.map((s) => (
        <div
          key={s.key}
          className="h-full first:rounded-l-full last:rounded-r-full transition-[width] duration-300"
          style={{ width: `${total > 0 ? (s.count / total) * 100 : 0}%`, background: s.color }}
        />
      ))}
    </div>
  );
}

function Legend({ segments, total }: { segments: Segment[]; total: number }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
      {segments.map((s) => (
        <li key={s.key} className="flex items-center gap-2 text-xs">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} aria-hidden="true" />
          <span className="flex-1 min-w-0 truncate text-primary">{s.label}</span>
          <span className="tabular-nums text-primary">{s.count}</span>
          <span className="tabular-nums text-muted w-9 text-right">
            {total > 0 ? Math.round((s.count / total) * 100) : 0}%
          </span>
        </li>
      ))}
    </ul>
  );
}

function Block({
  title,
  segments,
  total,
  unit,
  emptyText,
}: {
  title: string;
  segments: Segment[];
  total: number;
  unit: string;
  emptyText: string;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-xs font-semibold text-primary">{title}</h3>
        <span className="text-[11px] text-muted tabular-nums">
          {total} {unit}
        </span>
      </div>
      {segments.length === 0 ? (
        <div className="text-xs text-muted">{emptyText}</div>
      ) : (
        <>
          <SegmentedBar segments={segments} total={total} label={`${title} distribution`} />
          <Legend segments={segments} total={total} />
        </>
      )}
    </div>
  );
}

export interface DistributionPanelProps {
  vendors: Record<string, number>;
  switchTotal: number;
  speeds: Record<string, number>;
  linkTotal: number;
}

export function DistributionPanel({ vendors, switchTotal, speeds, linkTotal }: DistributionPanelProps) {
  const vendorSegments: Segment[] = Object.entries(vendors)
    .sort((a, b) => b[1] - a[1])
    .map(([vendor, count]) => ({
      key: vendor,
      count,
      color: VENDOR_COLOR[vendor] ?? "var(--muted)",
      label: (
        <span className="inline-flex items-center gap-1.5">
          {VENDOR_LABEL[vendor] || vendor}
          <span className="text-[9px] font-semibold text-muted font-mono">{VENDOR_ICON[vendor] || "[--]"}</span>
        </span>
      ),
    }));

  const speedSegments: Segment[] = Object.entries(speeds)
    .sort((a, b) => (SPEED_LABEL_MBPS[b[0]] ?? 0) - (SPEED_LABEL_MBPS[a[0]] ?? 0))
    .map(([speed, count]) => ({
      key: speed,
      count,
      label: speed === "?" ? "Unknown" : speed,
      color: SPEED_LABEL_MBPS[speed] != null ? speedColor(SPEED_LABEL_MBPS[speed]) : "var(--line-strong)",
    }));

  // Sum from the data itself so the bars always fill to 100%.
  const vendorSum = vendorSegments.reduce((s, x) => s + x.count, 0);
  const speedSum = speedSegments.reduce((s, x) => s + x.count, 0);

  return (
    <section
      aria-labelledby="distribution-heading"
      className="bg-panel border border-line rounded-card shadow-card px-5 py-4 flex flex-col gap-5"
    >
      <h2 id="distribution-heading" className="m-0 text-sm font-semibold text-primary">
        Composition
      </h2>
      <Block
        title="Vendors"
        segments={vendorSegments}
        total={vendorSum || switchTotal}
        unit="switches"
        emptyText="No switches discovered"
      />
      <Block
        title="Link speeds"
        segments={speedSegments}
        total={speedSum || linkTotal}
        unit="links"
        emptyText="No links discovered"
      />
    </section>
  );
}
