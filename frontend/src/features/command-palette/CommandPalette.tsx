// Global command palette: Ctrl/Cmd+K anywhere, "/" when not typing.
// Searches pages, actions and cached topology/endpoint data; selecting a
// switch, endpoint, rack or port opens the inspector drawer in place.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Cable,
  Container,
  EthernetPort,
  LayoutDashboard,
  MonitorSmartphone,
  Network,
  Palette,
  Radar,
  Router,
  ScrollText,
  Search,
  Server,
  Settings,
  SunMoon,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useEndpoints, useTopology } from "../../hooks/api";
import { useInspector } from "../../hooks/useInspector";
import { useStartScan } from "../../hooks/useStartScan";
import { useTheme } from "../../theme/ThemeProvider";
import { Spinner } from "../../components/ui";
import { buildPaletteIndex, iconFor, resolveRecent, type PaletteIcon, type PaletteItem } from "./paletteIndex";
import { buildPaletteResults, type MatchRange } from "./search";
import { readRecent } from "./recent";
import { usePaletteStore } from "./paletteStore";

const ICONS: Record<PaletteIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  map: Waypoints,
  devices: Server,
  network: Network,
  racks: Container,
  logs: ScrollText,
  settings: Settings,
  styleguide: Palette,
  scan: Radar,
  theme: SunMoon,
  switch: Router,
  endpoint: MonitorSmartphone,
  rack: Container,
  port: EthernetPort,
};

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Another modal dialog (not the palette) currently owns the keyboard. */
function otherModalOpen(): boolean {
  return document.querySelector('[data-modal]:not([data-command-palette])') !== null;
}

function Highlighted({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <span key={i} className="font-semibold text-primary">
        {text.slice(start, end)}
      </span>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { open: openInspector } = useInspector();
  const startScan = useStartScan();
  const toggleTheme = useTheme((s) => s.toggleTheme);
  const topologyQuery = useTopology();
  const endpointsQuery = useEndpoints();

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const index = useMemo(
    () => buildPaletteIndex(topologyQuery.data, endpointsQuery.data),
    [topologyQuery.data, endpointsQuery.data],
  );
  const recent = useMemo(() => resolveRecent(readRecent(), index), [index]);
  const groups = useMemo(() => buildPaletteResults(query, index, recent), [query, index, recent]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Focus the input on open and restore the previous focus on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optionId = (i: number) => `${listId}-option-${i}`;

  useEffect(() => {
    if (activeIndex < 0) return;
    const el = document.getElementById(`${listId}-option-${activeIndex}`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId]);

  const run = useCallback(
    (item: PaletteItem) => {
      onClose();
      const command = item.payload;
      if (command.type === "navigate") navigate(command.to);
      else if (command.type === "inspect") openInspector(command.kind, command.id);
      else if (command.action === "scan") void startScan();
      else toggleTheme();
    },
    [onClose, navigate, openInspector, startScan, toggleTheme],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + delta + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0) run(flat[activeIndex].item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Keep the Escape away from document-level listeners (inspector drawer).
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // The input is the only focus stop inside the palette.
      e.preventDefault();
    }
  };

  const loading = topologyQuery.isLoading || endpointsQuery.isLoading;
  let rowIndex = -1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim px-4 pt-[12vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-modal
        data-command-palette
        className="w-[640px] max-w-full bg-panel border border-line rounded-card shadow-raised flex flex-col max-h-[70vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 border-b border-line">
          <Search size={18} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label="Search pages, actions, switches, endpoints, racks and ports"
            placeholder="Search switches, endpoints, racks, ports or commands..."
            spellCheck={false}
            autoComplete="off"
            className="flex-1 min-w-0 h-14 bg-transparent text-[15px] text-primary placeholder:text-muted outline-none"
          />
          {loading && <Spinner size={14} />}
          <kbd className="hidden sm:inline-flex shrink-0 items-center px-1.5 py-0.5 rounded border border-line bg-panel-2 font-mono text-[10px] text-muted">
            Esc
          </kbd>
        </div>

        <div id={listId} role="listbox" aria-label="Results" className="flex-1 overflow-y-auto py-2">
          {flat.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-muted">
              {query.trim() ? `No results for "${query.trim()}"` : "Type to search"}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.id} role="group" aria-labelledby={`${listId}-${group.id}`} className="pb-1">
              <div
                id={`${listId}-${group.id}`}
                className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted"
              >
                {group.label}
              </div>
              {group.hits.map((hit) => {
                rowIndex += 1;
                const i = rowIndex;
                const isActive = i === activeIndex;
                const Icon = ICONS[iconFor(hit.item)] ?? Cable;
                return (
                  <div
                    key={hit.item.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isActive}
                    onMouseMove={() => {
                      if (!isActive) setActive(i);
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(hit.item)}
                    className={`mx-2 flex items-center gap-3 px-3 py-2 rounded-control cursor-pointer ${
                      isActive ? "bg-accent-soft" : ""
                    }`}
                  >
                    <Icon
                      size={16}
                      strokeWidth={1.75}
                      className={`shrink-0 ${isActive ? "text-accent" : "text-muted"}`}
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0 flex items-baseline gap-2">
                      <span className="truncate text-[13px] text-primary">
                        <Highlighted text={hit.item.label} ranges={hit.labelRanges} />
                      </span>
                      {hit.item.detail && (
                        <span className="truncate font-mono text-[11px] text-muted">{hit.item.detail}</span>
                      )}
                    </div>
                    {hit.item.hint && <span className="shrink-0 text-[10px] text-muted">{hit.item.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="hidden sm:flex items-center gap-4 px-4 py-2 border-t border-line text-[10px] text-muted">
          <span>Up/Down to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Mount once in the app shell. Registers the global shortcuts and renders the
 * palette dialog while open.
 */
export default function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const toggle = usePaletteStore((s) => s.toggle);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isModK = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
      if (isModK) {
        // Always swallow the combo so the browser search bar does not open.
        e.preventDefault();
        if (!usePaletteStore.getState().open && otherModalOpen()) return;
        toggle();
        return;
      }
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (usePaletteStore.getState().open || isTypingTarget(e.target) || otherModalOpen()) return;
        e.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setOpen, toggle]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  return open ? <PaletteDialog onClose={close} /> : null;
}
