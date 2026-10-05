import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { dialogPreset, fadePreset, useReducedMotion } from "../../theme/motion";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
}

const FOCUSABLE =
  'a[href], button, textarea, input:not([type="hidden"]), select, [tabindex]';

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element => {
    if (element.tabIndex < 0 || element.matches(":disabled") ||
      element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    for (let current: HTMLElement | null = element; current && current !== panel; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}

export function Modal({ open, onClose, title, children, width = 480 }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape to close
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Focus trap + initial focus
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = focusableElements(panel)[0];
    (first ?? panel).focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !panel) return;
      const focusable = focusableElements(panel);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === panel)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <ModalLayer key="modal" panelRef={panelRef} titleId={titleId} title={title} width={width} onClose={onClose}>
          {children}
        </ModalLayer>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface ModalLayerProps {
  panelRef: RefObject<HTMLDivElement | null>;
  titleId: string;
  title?: ReactNode;
  width: number;
  onClose: () => void;
  children: ReactNode;
}

// Scrim plus panel. While the exit animation runs the layer is already
// closed: it drops `data-modal` and `aria-modal` (so global shortcuts are no longer blocked),
// leaves the accessibility tree and ignores pointer input.
function ModalLayer({ panelRef, titleId, title, width, onClose, children }: ModalLayerProps) {
  const isPresent = useIsPresent();
  const reduced = useReducedMotion();
  return (
    <m.div
      {...fadePreset(reduced)}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-scrim ${isPresent ? "" : "pointer-events-none"}`}
      aria-hidden={isPresent ? undefined : true}
      onClick={onClose}
    >
      <m.div
        {...dialogPreset(reduced)}
        ref={panelRef}
        role="dialog"
        aria-modal={isPresent ? "true" : undefined}
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? "Dialog" : undefined}
        data-modal={isPresent ? "" : undefined}
        tabIndex={-1}
        style={{ width, maxWidth: "calc(100vw - 32px)" }}
        className="bg-panel border border-line rounded-card shadow-raised outline-none max-h-[calc(100dvh-32px)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {title != null && (
          <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
            <div id={titleId} className="text-sm font-semibold text-primary">{title}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-control text-muted hover:bg-panel-2 hover:text-primary transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="4" x2="20" y2="20" />
                <line x1="20" y1="4" x2="4" y2="20" />
              </svg>
            </button>
          </div>
        )}
        <div className="min-h-0 p-4 overflow-auto">{children}</div>
      </m.div>
    </m.div>
  );
}
