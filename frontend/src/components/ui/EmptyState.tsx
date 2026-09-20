import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, hint, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 py-10 text-center ${className}`}>
      <div className="text-sm font-semibold text-muted">{title}</div>
      {hint != null && <div className="text-xs text-muted opacity-70">{hint}</div>}
      {action != null && <div className="mt-2">{action}</div>}
    </div>
  );
}
