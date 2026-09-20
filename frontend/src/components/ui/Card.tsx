import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  actions?: ReactNode;
}

export function Card({ title, actions, className = "", children, ...props }: CardProps) {
  return (
    <div
      className={`bg-panel border border-line rounded-lg ${className}`}
      {...props}
    >
      {(title != null || actions != null) && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
          <div className="text-xs font-semibold text-primary">{title}</div>
          {actions != null && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}
