import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { CircleCheck, CircleX, Info, TriangleAlert, type LucideIcon } from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  createdAt: number;
}

interface ToastContextValue {
  addToast: (message: string, type?: ToastType) => void;
  removeToast: (id: string) => void;
}

// ── Context ──────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

// ── Styles ───────────────────────────────────────────────────────────────────

// Soft background + strong text pairs from the theme tokens (AA in both themes).
const TOAST_CLASSES: Record<ToastType, string> = {
  success: "bg-success-soft text-success border-success/30",
  error:   "bg-danger-soft text-danger border-danger/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  info:    "bg-panel text-primary border-line",
};

// Icon plus a hidden status word so status is never conveyed by color alone.
const ICONS: Record<ToastType, LucideIcon> = {
  success: CircleCheck,
  error:   CircleX,
  warning: TriangleAlert,
  info:    Info,
};

const STATUS_WORD: Record<ToastType, string> = {
  success: "Success",
  error:   "Error",
  warning: "Warning",
  info:    "Info",
};

const AUTO_DISMISS_MS = 5000;

// ── Single toast element ─────────────────────────────────────────────────────

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    // slide-in after mount
    const frame = requestAnimationFrame(() => setVisible(true));
    timerRef.current = setTimeout(() => onRemove(toast.id), AUTO_DISMISS_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Icon = ICONS[toast.type];

  return (
    <div
      role="alert"
      className={`flex items-center gap-2 px-3.5 py-2.5 rounded-control border text-xs font-medium shadow-raised cursor-pointer max-w-[340px] break-words transition-[transform,opacity] duration-300 ease-out ${TOAST_CLASSES[toast.type]}`}
      style={{
        transform: visible ? "translateX(0)" : "translateX(120%)",
        opacity: visible ? 1 : 0,
      }}
      onClick={() => onRemove(toast.id)}
    >
      <Icon
        size={16}
        aria-hidden="true"
        className={`shrink-0 ${toast.type === "info" ? "text-external" : ""}`}
      />
      <span className="sr-only">{STATUS_WORD[toast.type]}: </span>
      <span className="flex-1">{toast.message}</span>
    </div>
  );
}

// ── Provider ─────────────────────────────────────────────────────────────────

let idCounter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: ToastType = "info") => {
    const id = `toast-${++idCounter}-${Date.now()}`;
    setToasts(prev => [...prev, { id, message, type, createdAt: Date.now() }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={useMemo(() => ({ addToast, removeToast }), [addToast, removeToast])}>
      {children}
      {/* Toast container - fixed bottom-right */}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          display: "flex",
          flexDirection: "column-reverse",
          gap: 8,
          zIndex: 9999,
          pointerEvents: "none",
        }}
      >
        {toasts.map(t => (
          <div key={t.id} style={{ pointerEvents: "auto" }}>
            <ToastItem toast={t} onRemove={removeToast} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
