// Shared formatters for the scan settings components.

export function fmtDuration(ms: number | undefined | null): string {
  const value = Number(ms || 0);
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function fmtTs(ts: string | undefined | null): string {
  if (!ts) return "-";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString();
}
