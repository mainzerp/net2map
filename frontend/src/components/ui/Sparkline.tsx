// Dependency-free inline SVG sparkline. Null values are gaps: the line breaks
// there instead of interpolating. Color comes from the tone's text-* token via
// currentColor, so it follows the light/dark theme automatically.

export type SparklineTone = "ok" | "warning" | "danger" | "neutral";

export interface SparklineProps {
  values: (number | null)[];
  ariaLabel: string;
  height?: number;
  tone?: SparklineTone;
  // Draws a soft fill under the line.
  area?: boolean;
  // Reference value drawn as a dashed horizontal line (e.g. a latency baseline).
  baseline?: number | null;
  className?: string;
}

const TONE_CLASS: Record<SparklineTone, string> = {
  ok: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-muted",
};

// Internal coordinate space; the SVG stretches to its container width.
const VIEW_WIDTH = 100;

export interface SparklineGeometry {
  // One path per run of consecutive non-null values with at least two points.
  lines: string[];
  // Closed fill paths matching `lines`.
  areas: string[];
  // Isolated single values (no neighbor to connect to).
  dots: { x: number; y: number }[];
  baselineY: number | null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Pure geometry for a sparkline in a VIEW_WIDTH x height box. */
export function sparklineGeometry(
  values: (number | null)[],
  height: number,
  baseline: number | null = null,
): SparklineGeometry {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const result: SparklineGeometry = { lines: [], areas: [], dots: [], baselineY: null };
  if (finite.length === 0) return result;

  const domain = baseline != null && Number.isFinite(baseline) ? [...finite, baseline] : finite;
  let min = Math.min(...domain);
  let max = Math.max(...domain);
  if (max === min) {
    min -= 1;
    max += 1;
  }
  // Keep a 1-unit inset so the stroke is not clipped at the edges.
  const pad = 1;
  const y = (v: number) => round(pad + (1 - (v - min) / (max - min)) * (height - 2 * pad));
  const step = values.length > 1 ? VIEW_WIDTH / (values.length - 1) : 0;
  const x = (i: number) => round(values.length > 1 ? i * step : VIEW_WIDTH / 2);

  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length === 1) {
      result.dots.push(run[0]);
    } else if (run.length > 1) {
      const d = run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
      result.lines.push(d);
      result.areas.push(`${d} L${run[run.length - 1].x},${height} L${run[0].x},${height} Z`);
    }
    run = [];
  };
  values.forEach((v, i) => {
    if (typeof v === "number" && Number.isFinite(v)) run.push({ x: x(i), y: y(v) });
    else flush();
  });
  flush();

  if (baseline != null && Number.isFinite(baseline)) result.baselineY = y(baseline);
  return result;
}

export function Sparkline({
  values,
  ariaLabel,
  height = 32,
  tone = "neutral",
  area = false,
  baseline = null,
  className = "",
}: SparklineProps) {
  const geo = sparklineGeometry(values, height, baseline);
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      preserveAspectRatio="none"
      height={height}
      className={`block w-full overflow-visible ${TONE_CLASS[tone]} ${className}`}
    >
      {geo.baselineY != null && (
        <line
          data-testid="sparkline-baseline"
          x1={0}
          x2={VIEW_WIDTH}
          y1={geo.baselineY}
          y2={geo.baselineY}
          className="text-muted"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="3 3"
          strokeOpacity={0.7}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {area &&
        geo.areas.map((d, i) => (
          <path key={`a${i}`} d={d} fill="currentColor" fillOpacity={0.12} stroke="none" />
        ))}
      {geo.lines.map((d, i) => (
        <path
          key={`l${i}`}
          data-testid="sparkline-line"
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {geo.dots.map((p, i) => (
        <line
          key={`d${i}`}
          data-testid="sparkline-dot"
          x1={p.x}
          x2={p.x}
          y1={p.y}
          y2={p.y}
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
