import type { ReactNode } from "react";

export interface TooltipProps {
  label: string;
  children: ReactNode;
}

// Minimal tooltip: relies on the native title attribute on hover.
export function Tooltip({ label, children }: TooltipProps) {
  return (
    <span title={label} className="inline-flex">
      {children}
    </span>
  );
}
