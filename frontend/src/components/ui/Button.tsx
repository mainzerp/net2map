import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-contrast border border-transparent enabled:hover:bg-accent-strong disabled:opacity-60",
  secondary:
    "bg-panel text-primary border border-line-strong enabled:hover:bg-panel-2 enabled:hover:border-muted disabled:opacity-60",
  danger:
    "bg-transparent text-danger border border-danger enabled:hover:bg-danger-soft disabled:opacity-60",
  ghost:
    "bg-transparent text-muted border border-transparent enabled:hover:text-primary enabled:hover:bg-panel-2 disabled:opacity-60",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-[11px] rounded-control",
  md: "px-4 py-2 text-xs rounded-control",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className = "", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 font-semibold transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  );
});
