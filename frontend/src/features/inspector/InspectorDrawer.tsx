// Shared right-side inspector drawer, mounted once in the app shell. It is
// driven by the `inspect` URL param (see hooks/useInspector.ts) and does not
// block the page: no backdrop on desktop, a scrim only below the md
// breakpoint where the drawer covers the full width.

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useInspector, type InspectorKind, type InspectorTarget } from "../../hooks/useInspector";
import { pushRecent } from "../command-palette/recent";
import DeviceInspector from "./DeviceInspector";
import EndpointInspector from "./EndpointInspector";
import RackInspector from "./RackInspector";

const KIND_LABELS: Record<InspectorKind, string> = {
  device: "Switch",
  endpoint: "Endpoint",
  rack: "Rack",
};

// Matches the slide duration below; content stays rendered while sliding out.
const EXIT_DELAY_MS = 180;

// A modal dialog (or the command palette) owns Escape while it is open.
const MODAL_SELECTOR = '[data-modal], [role="dialog"][aria-modal="true"]';

export default function InspectorDrawer() {
  const { target, raw, close } = useInspector();
  const [shown, setShown] = useState<InspectorTarget | null>(target);
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const isOpen = target !== null;

  useEffect(() => {
    if (target) {
      setShown(target);
      return;
    }
    const timer = setTimeout(() => setShown(null), EXIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [target]);

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

  const display = target ?? shown;

  return (
    <>
      {isOpen && <div className="md:hidden fixed inset-0 z-40 bg-scrim" onClick={close} aria-hidden="true" />}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-hidden={!isOpen}
        data-inspector
        data-inspect-target={raw ?? undefined}
        tabIndex={-1}
        className={`fixed inset-y-0 right-0 z-40 w-full md:w-[420px] bg-panel border-l border-line shadow-raised flex flex-col outline-none transition-[transform,visibility] duration-[180ms] ease-out motion-reduce:transition-none ${
          isOpen ? "translate-x-0 visible" : "translate-x-full invisible"
        }`}
      >
        {display && (
          <>
            <div className="shrink-0 flex items-center gap-2 h-12 px-5 border-b border-line">
              <span className="eyebrow">{KIND_LABELS[display.kind]}</span>
              <button
                type="button"
                onClick={close}
                aria-label="Close inspector"
                title="Close (Esc)"
                className="ml-auto inline-flex items-center justify-center w-8 h-8 rounded-control text-muted hover:text-primary hover:bg-panel-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <X size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {display.kind === "device" && <DeviceInspector key={display.id} id={display.id} titleId={titleId} />}
              {display.kind === "endpoint" && <EndpointInspector key={display.id} id={display.id} titleId={titleId} />}
              {display.kind === "rack" && <RackInspector key={display.id} id={display.id} titleId={titleId} />}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
