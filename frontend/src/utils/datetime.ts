// Shared timestamp formatting for table cells and status lines.
export function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

// Backend timestamps are stored in UTC; naive ISO strings (no "Z" or offset)
// must therefore be parsed as UTC, not local time.
function parseUtc(ts: string): Date {
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(ts);
  return new Date(hasZone ? ts : `${ts}Z`);
}

// Compact relative time, e.g. "just now", "5m ago", "3h ago", "2d ago".
export function formatRelativeTime(ts: string | null | undefined, now: number = Date.now()): string {
  if (!ts) return "-";
  const d = parseUtc(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const secs = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatTimestamp(d.toISOString());
}
