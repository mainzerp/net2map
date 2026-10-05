// Shared building blocks for the inspector drawer views.

import type { ReactNode } from "react";
import { Button, EmptyState, Spinner, type StatusDotStatus } from "../../components/ui";

export function InspectorSection({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="px-5 py-4 border-b border-line last:border-b-0">
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

export function FactList({ facts }: { facts: Fact[] }) {
  const visible = facts.filter((f) => f.value != null && f.value !== "");
  if (visible.length === 0) return <div className="text-xs text-muted">No details recorded</div>;
  return (
    <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {visible.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted">{fact.label}</dt>
          <dd className={`min-w-0 break-words text-primary ${fact.mono ? "font-mono text-[11px]" : ""}`}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Inline text button used for in-drawer cross links (rack, switch, ...). */
export function LinkButton({ onClick, children, title }: { onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="text-accent hover:text-accent-strong hover:underline cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent rounded-sm"
    >
      {children}
    </button>
  );
}

export function InspectorTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="text-base font-bold text-primary break-words">
      {children}
    </h2>
  );
}

export function InspectorLoading({ titleId }: { titleId: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted">
      <h2 id={titleId} className="sr-only">
        Loading details
      </h2>
      <Spinner size={14} />
      Loading...
    </div>
  );
}

export function InspectorNotFound({ titleId, what, onClose }: { titleId: string; what: string; onClose: () => void }) {
  return (
    <div className="px-5">
      <h2 id={titleId} className="sr-only">
        {what} not found
      </h2>
      <EmptyState
        title={`${what} not found`}
        hint="It may have been removed or the link is out of date."
        action={
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        }
      />
    </div>
  );
}

export function pingDotStatus(pingStatus: unknown): StatusDotStatus {
  if (pingStatus === "online") return "up";
  if (pingStatus === "offline") return "down";
  return "unknown";
}

export function pingWord(pingStatus: unknown): string {
  if (pingStatus === "online") return "Online";
  if (pingStatus === "offline") return "Offline";
  return "Unknown";
}
