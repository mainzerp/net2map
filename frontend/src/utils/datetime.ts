// Shared timestamp formatting for table cells and status lines.
export function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
