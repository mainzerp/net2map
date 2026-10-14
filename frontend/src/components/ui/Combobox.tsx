import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Input } from "./Input";

export interface ComboboxProps<T> {
  /** Current text in the search input (controlled). */
  query: string;
  onQueryChange: (query: string) => void;
  /** Options to show, already filtered by the caller. */
  items: T[];
  getKey: (item: T) => string | number;
  renderItem: (item: T) => ReactNode;
  /** Called when an option is picked by click or Enter. Focus stays in the input. */
  onSelect: (item: T) => void;
  placeholder?: string;
  /** Accessible name of the input. */
  ariaLabel?: string;
  /** Shown instead of the list when there are no items. */
  emptyText?: ReactNode;
  /** Optional hint below the options, e.g. "12 more, refine search". */
  footer?: ReactNode;
  disabled?: boolean;
  className?: string;
}

// Type-to-filter picker: a text input with a listbox of matching options.
// ArrowUp/ArrowDown move the active option, Enter picks it, Escape clears the
// query (and closes the list when it is already empty). The input keeps focus
// after a pick so several options can be chosen in a row.
export function Combobox<T>({
  query,
  onQueryChange,
  items,
  getKey,
  renderItem,
  onSelect,
  placeholder,
  ariaLabel,
  emptyText = "No matches",
  footer,
  disabled = false,
  className = "",
}: ComboboxProps<T>) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the active index inside the current item range.
  useEffect(() => {
    setActive((a) => (items.length === 0 ? 0 : Math.min(a, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  const pick = (item: T) => {
    onSelect(item);
    setOpen(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (items.length > 0) setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (items.length > 0) setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      if (open && items[active]) {
        e.preventDefault();
        pick(items[active]);
      }
    } else if (e.key === "Escape") {
      if (query) {
        e.preventDefault();
        e.stopPropagation();
        onQueryChange("");
        setActive(0);
      } else if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  const activeId = open && items[active] ? `${listId}-opt-${active}` : undefined;

  return (
    <div className={`relative ${className}`}>
      <Input
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => { onQueryChange(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-control border border-line-strong bg-panel shadow-raised">
          {items.length === 0 ? (
            <div className="px-2.5 py-2 text-[11px] text-muted">{emptyText}</div>
          ) : (
            <ul ref={listRef} id={listId} role="listbox" className="max-h-56 overflow-y-auto py-1">
              {items.map((item, i) => (
                <li
                  key={getKey(item)}
                  id={`${listId}-opt-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  // Keep focus in the input so the next pick can follow immediately.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(item)}
                  className={`px-2.5 py-1 text-[11px] cursor-pointer ${
                    i === active ? "bg-accent-soft text-accent" : "text-primary"
                  }`}
                >
                  {renderItem(item)}
                </li>
              ))}
            </ul>
          )}
          {footer && <div className="px-2.5 py-1 border-t border-line text-[10px] text-muted">{footer}</div>}
        </div>
      )}
    </div>
  );
}
