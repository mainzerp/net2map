import { forwardRef, type SelectHTMLAttributes } from "react";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid = false, className = "", children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={`w-full px-2.5 py-1.5 rounded-control bg-panel text-primary text-xs border outline-none transition-colors focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-accent ${
        invalid ? "border-danger" : "border-line-strong"
      } ${className}`}
      {...props}
    >
      {children}
    </select>
  );
});
