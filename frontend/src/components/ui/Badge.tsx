import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-panel-2 text-muted border-line-strong",
  accent: "bg-panel-2 text-accent border-accent",
  success: "bg-panel-2 text-success border-success",
  warning: "bg-panel-2 text-warning border-warning",
  danger: "bg-panel-2 text-danger border-danger",
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

const DOT_COLORS: Record<StatusDotStatus, string> = {
  up: "bg-success",
  down: "bg-danger",
  unknown: "bg-muted",
};

export function StatusDot({ status, className = "", ...props }: StatusDotProps) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${DOT_COLORS[status]} ${className}`}
      {...props}
    />
  );
}
