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
      className={`w-full px-2.5 py-1.5 rounded-md bg-panel-2 text-primary text-xs border outline-none transition-colors focus:border-accent ${
        invalid ? "border-danger" : "border-line-strong"
      } ${className}`}
      {...props}
    >
      {children}
    </select>
  );
});
