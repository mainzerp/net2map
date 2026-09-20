import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-strong text-white border border-transparent hover:bg-accent disabled:opacity-60",
  secondary:
    "bg-panel-2 text-primary border border-line-strong hover:border-accent hover:text-accent disabled:opacity-60",
  danger:
    "bg-transparent text-danger border border-danger hover:bg-danger hover:text-white disabled:opacity-60",
  ghost:
    "bg-transparent text-muted border border-transparent hover:text-primary hover:bg-panel-2 disabled:opacity-60",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-[11px] rounded",
  md: "px-4 py-2 text-xs rounded-md",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className = "", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  );
});
