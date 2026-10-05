// Shared right-side inspector drawer, mounted once in the app shell. It is
// driven by the `inspect` URL param (see hooks/useInspector.ts) and does not
// block the page: no backdrop on desktop, a scrim only below the md
// breakpoint where the drawer covers the full width.

import { useEffect, useId, useRef, type RefObject } from "react";
import { X } from "lucide-react";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { useInspector, type InspectorKind, type InspectorTarget } from "../../hooks/useInspector";
import { pushRecent } from "../command-palette/recent";
import DeviceInspector from "./DeviceInspector";
import EndpointInspector from "./EndpointInspector";
import RackInspector from "./RackInspector";
import { DURATION, fadePreset, slidePreset, useReducedMotion } from "../../theme/motion";

const KIND_LABELS: Record<InspectorKind, string> = {
  device: "Switch",
  endpoint: "Endpoint",
  rack: "Rack",
};

// A modal dialog (or the command palette) owns Escape while it is open.
const MODAL_SELECTOR = '[data-modal], [role="dialog"][aria-modal="true"]';

export default function InspectorDrawer() {
  const { target, raw, close } = useInspector();
  const reduced = useReducedMotion();
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const isOpen = target !== null;

  // Remember opened targets for the palette's "Recent" group.
  useEffect(() => {
    if (target) pushRecent(target);
  }, [target]);

  // Move focus into the drawer on open; give it back on close.
  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement && !panel?.contains(active) ? active : null;
    panel?.focus({ preventScroll: true });
    return () => {
      const restore = restoreFocusRef.current;
      const current = document.activeElement;
      // Only reclaim focus if it is still inside the drawer (or was dropped).
      const focusInDrawer = !current || current === document.body || (panel?.contains(current) ?? false);
      if (restore?.isConnected && focusInDrawer) restore.focus({ preventScroll: true });
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(MODAL_SELECTOR)) return;
      close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, close]);

  return (
    <>
      <AnimatePresence>
        {isOpen && (
          <m.div
            key="inspector-scrim"
            {...fadePreset(reduced)}
            className="md:hidden fixed inset-0 z-40 bg-scrim"
            onClick={close}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {target && (
          <DrawerPanel
            key="inspector"
            target={target}
            raw={raw}
            panelRef={panelRef}
            titleId={titleId}
            reduced={reduced}
            onClose={close}
          />
        )}
      </AnimatePresence>
    </>
  );
}

interface DrawerPanelProps {
  target: InspectorTarget;
  raw: string | null;
  panelRef: RefObject<HTMLElement | null>;
  titleId: string;
  reduced: boolean;
  onClose: () => void;
}

// The sliding panel. While it slides out it keeps its last target (the
// exiting element is frozen by AnimatePresence) but already counts as closed:
// hidden from assistive tech and pointer input.
function DrawerPanel({ target, raw, panelRef, titleId, reduced, onClose }: DrawerPanelProps) {
  const isPresent = useIsPresent();
  const contentKey = raw ?? `${target.kind}:${target.id}`;
  return (
    <m.aside
      {...slidePreset(reduced, "right")}
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-hidden={isPresent ? undefined : true}
      data-inspector
      data-inspect-target={raw ?? undefined}
      tabIndex={-1}
      className={`fixed inset-y-0 right-0 z-40 w-full md:w-[420px] bg-panel border-l border-line shadow-raised flex flex-col outline-none ${
        isPresent ? "" : "pointer-events-none"
      }`}
    >
      <div className="shrink-0 flex items-center gap-2 h-12 px-5 border-b border-line">
        <span className="eyebrow">{KIND_LABELS[target.kind]}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          title="Close (Esc)"
          className="ml-auto inline-flex items-center justify-center w-8 h-8 rounded-control text-muted hover:text-primary hover:bg-panel-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {/* Fade the body out and the next target in when switching targets
          (sequential, so the title id is never duplicated). The first open is
          covered by the panel slide, so no extra fade there. */}
      <div className="flex-1 min-h-0 flex flex-col">
        <AnimatePresence initial={false} mode="wait">
          <m.div key={contentKey} {...fadePreset(reduced, DURATION.fast)} className="flex-1 min-h-0 overflow-y-auto">
            {target.kind === "device" && <DeviceInspector id={target.id} titleId={titleId} />}
            {target.kind === "endpoint" && <EndpointInspector id={target.id} titleId={titleId} />}
            {target.kind === "rack" && <RackInspector id={target.id} titleId={titleId} />}
          </m.div>
        </AnimatePresence>
      </div>
    </m.aside>
  );
}
