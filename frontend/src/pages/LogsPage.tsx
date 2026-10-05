import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../components/ToastProvider";
import { useLogs, type LogEntry } from "../hooks/api";
import { Badge, Button, EmptyState, Input, Select, Spinner, type BadgeTone } from "../components/ui";

function levelTone(level: string | undefined): BadgeTone {
  if (level === "ERROR") return "danger";
  if (level === "WARNING") return "warning";
  if (level === "INFO") return "accent";
  return "neutral";
}

const LIMIT_OPTIONS = [100, 300, 500, 1000, 2000];

export default function LogsPage() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [levelFilter, setLevelFilter] = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [textFilter, setTextFilter] = useState("");
  const [debouncedText, setDebouncedText] = useState("");
  const [limit, setLimit] = useState(300);
  const { addToast } = useToast();
  const lastToastedErrorRef = useRef<string | null>(null);

  // Debounce the free-text filter so each keystroke does not fire a request
  useEffect(() => {
    const t = setTimeout(() => setDebouncedText(textFilter), 300);
    return () => clearTimeout(t);
  }, [textFilter]);

  const logsQuery = useLogs(
    {
      limit,
      level: levelFilter || undefined,
      eventPrefix: eventFilter || undefined,
      q: debouncedText || undefined,
    },
    autoRefresh ? 5000 : false,
  );

  // Surface role/permission failures loudly, but do not spam a toast on every
  // auto-refresh tick while the same error persists.
  useEffect(() => {
    const error = logsQuery.error;
    if (!error) {
      lastToastedErrorRef.current = null;
      return;
    }
    const msg = error instanceof Error ? error.message : "Failed to load logs";
    if (lastToastedErrorRef.current !== msg) {
      lastToastedErrorRef.current = msg;
      addToast(msg, "error");
    }
  }, [logsQuery.error, addToast]);

  const rows = useMemo(() => [...(logsQuery.data ?? [])].reverse(), [logsQuery.data]);

  return (
    <div className="h-full flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-primary">Logs</h1>
          <p className="text-xs text-muted mt-0.5">Structured backend events (JSON)</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            aria-label="Filter by level"
            className="w-auto"
          >
            <option value="">All levels</option>
            <option value="INFO">INFO</option>
            <option value="WARNING">WARNING</option>
            <option value="ERROR">ERROR</option>
          </Select>
          <Select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            aria-label="Log entry limit"
            className="w-auto"
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} entries
              </option>
            ))}
          </Select>
          <Input
            value={eventFilter}
            onChange={(e) => setEventFilter(e.target.value)}
            placeholder="event prefix, e.g. scan."
            aria-label="Filter by event prefix"
            className="w-52"
          />
          <Input
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="search payload text"
            aria-label="Search payload text"
            className="w-52"
          />
          <label className="flex items-center gap-1.5 text-[11px] text-muted select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-accent cursor-pointer"
            />
            Auto refresh
          </label>
          <Button variant="secondary" size="sm" onClick={() => void logsQuery.refetch()}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col bg-panel border border-line rounded-card overflow-hidden">
        <div className="grid grid-cols-[170px_90px_180px_1fr] gap-2 px-3 py-2 border-b border-line text-[10px] font-semibold uppercase tracking-wider text-muted">
          <span>Time</span>
          <span>Level</span>
          <span>Event</span>
          <span>Payload</span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {logsQuery.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
              <Spinner size={12} />
              Loading...
            </div>
          ) : logsQuery.isError ? (
            <div className="px-3 py-4 text-xs text-danger">
              Error: {logsQuery.error instanceof Error ? logsQuery.error.message : "Failed to load logs"}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title="No log entries" />
          ) : (
            rows.map((entry: LogEntry, idx: number) => {
              const { ts, level, event, ...payload } = entry || {};
              return (
                <div
                  key={`${entry.ts || ""}-${idx}`}
                  className="grid grid-cols-[170px_90px_180px_1fr] gap-2 px-3 py-2 border-b border-line last:border-0 text-[10px] items-start"
                >
                  <span className="text-muted whitespace-nowrap">{ts || "-"}</span>
                  <span>
                    <Badge tone={levelTone(level)}>{level || "-"}</Badge>
                  </span>
                  <span className="text-muted break-all">{event || "-"}</span>
                  <span className="text-accent break-words font-mono">{JSON.stringify(payload)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
