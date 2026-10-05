import { forwardRef, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className = "", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={`w-full px-2.5 py-1.5 rounded-control bg-panel text-primary text-xs border outline-none transition-colors placeholder:text-muted focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-accent ${
        invalid ? "border-danger" : "border-line-strong"
      } ${className}`}
      {...props}
    />
  );
});
