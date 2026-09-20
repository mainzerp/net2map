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

const TOAST_COLORS: Record<ToastType, { bg: string; border: string; color: string }> = {
  success: { bg: "#052e16", border: "#166534", color: "#4ade80" },
  error:   { bg: "#2a0a0a", border: "#7f1d1d", color: "#f87171" },
  warning: { bg: "#2a1f04", border: "#854d0e", color: "#facc15" },
  info:    { bg: "#082f49", border: "#0e7490", color: "#22d3ee" },
};

// ASCII markers only (project rule: no emoji / pictographic glyphs)
const ICONS: Record<ToastType, string> = {
  success: "OK",
  error:   "X",
  warning: "!",
  info:    "i",
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

  const c = TOAST_COLORS[toast.type];

  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 14px",
        borderRadius: 8,
        border: `1px solid ${c.border}`,
        backgroundColor: c.bg,
        color: c.color,
        fontSize: 12,
        fontFamily: "'Inter', system-ui, sans-serif",
        boxShadow: "0 4px 12px rgba(0,0,0,.4)",
        transform: visible ? "translateX(0)" : "translateX(120%)",
        opacity: visible ? 1 : 0,
        transition: "transform 0.3s ease, opacity 0.3s ease",
        cursor: "pointer",
        maxWidth: 340,
        wordBreak: "break-word",
      }}
      onClick={() => onRemove(toast.id)}
    >
      <span style={{ fontSize: 14, flexShrink: 0 }}>{ICONS[toast.type]}</span>
      <span style={{ flex: 1 }}>{toast.message}</span>
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
