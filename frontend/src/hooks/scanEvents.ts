import type { ScanProgress } from "../types";

// Synthetic progress event emitted by useScanProgress when the live
// connection cannot be (re-)established and it stops retrying.
export const SCAN_CONNECTION_LOST = "connection_lost";

// WebSocket event types after which a scan job is no longer tracked: normal
// completion (any final status), explicit failure/cancel events, and the
// synthetic connection-lost event.
export const SCAN_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "scan_complete",
  "scan_failed",
  "scan_cancelled",
  "scan_error",
  SCAN_CONNECTION_LOST,
]);

export function isScanTerminal(progress: ScanProgress | null | undefined): boolean {
  return !!progress && SCAN_TERMINAL_EVENT_TYPES.has(progress.type);
}
