import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

// Soft background + strong text pairs (AA contrast in both themes). Status is
// never conveyed by color alone: callers pass a word (and optionally an icon).
const TONES: Record<BadgeTone, string> = {
  neutral: "bg-panel-2 text-muted border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  success: "bg-success-soft text-success border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
};

export function Badge({ tone = "neutral", className = "", ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${TONES[tone]} ${className}`}
      {...props}
    />
  );
}

export type StatusDotStatus = "up" | "down" | "unknown";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  status: StatusDotStatus;
}

// Strong dot with a soft halo ring from the matching *-soft token.
const DOT_COLORS: Record<StatusDotStatus, string> = {
  up: "bg-success ring-success-soft",
  down: "bg-danger ring-danger-soft",
  unknown: "bg-muted ring-panel-2",
};

export function StatusDot({ status, className = "", ...props }: StatusDotProps) {
  return (
    <span
      className={`inline-block w-2 h-2 shrink-0 rounded-full ring-[3px] ${DOT_COLORS[status]} ${className}`}
      {...props}
    />
  );
}
