import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Input } from "./Input";
import { Select } from "./Select";

export type DataTableAlign = "left" | "center" | "right";
export type DataTableSortDirection = "asc" | "desc";

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  // Value extractor used for sorting. Defaults to the row field matching `key`.
  sortValue?: (row: T) => string | number;
  align?: DataTableAlign;
  className?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  loading?: boolean;
  skeletonRows?: number;

  // Search. The field renders when `searchable`; filtering happens whenever
  // both `search` (or internal state) and `searchText` are set. Pass a
  // controlled `search`/`onSearchChange` pair to sync with URL params.
  searchable?: boolean;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchText?: (row: T) => string;

  // Extra content rendered next to the search field (filters, actions).
  toolbar?: ReactNode;

  // Row selection (controlled). Select-all covers all filtered rows.
  selectable?: boolean;
  selectedKeys?: ReadonlySet<string | number>;
  onSelectionChange?: (keys: Set<string | number>) => void;

  // Client-side pagination (on by default).
  paginated?: boolean;
  pageSizes?: number[];
  defaultPageSize?: number;

  emptyTitle?: ReactNode;
  emptyHint?: ReactNode;
  rowClassName?: (row: T) => string;
}

const ALIGN_CLASS: Record<DataTableAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 5,
  searchable = false,
  search,
  onSearchChange,
  searchPlaceholder = "Search...",
  searchText,
  toolbar,
  selectable = false,
  selectedKeys,
  onSelectionChange,
  paginated = true,
  pageSizes = [25, 50, 100],
  defaultPageSize = 25,
  emptyTitle = "No rows",
  emptyHint,
  rowClassName,
}: DataTableProps<T>) {
  const [internalSearch, setInternalSearch] = useState("");
  const searchValue = search ?? internalSearch;
  const setSearchValue = (value: string) => {
    if (onSearchChange) onSearchChange(value);
    else setInternalSearch(value);
  };

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<DataTableSortDirection>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  // `rows` is deliberately not a dependency: callers may pass a freshly
  // filtered array each render, which would reset the page on every repaint.
  // Rows must be memoized upstream (useMemo) if identity stability matters.
  useEffect(() => {
    setPage(1);
  }, [searchValue, pageSize]);

  const cycleSort = (key: string) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey(null);
    }
  };

  const processed = useMemo(() => {
    let list = rows;
    const q = searchValue.trim().toLowerCase();
    if (q && searchText) {
      list = list.filter((row) => searchText(row).toLowerCase().includes(q));
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      const accessor =
        col?.sortValue ??
        ((row: T) => {
          const value = (row as Record<string, unknown>)[sortKey];
          return typeof value === "number" ? value : String(value ?? "");
        });
      const sorted = [...list].sort((a, b) => {
        const va = accessor(a);
        const vb = accessor(b);
        if (typeof va === "number" && typeof vb === "number") return va - vb;
        const sa = String(va);
        const sb = String(vb);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
      list = sortDir === "desc" ? sorted.reverse() : sorted;
    }
    return list;
  }, [rows, searchValue, searchText, sortKey, sortDir, columns]);

  // Selection state (select-all spans all filtered rows, not just the page).
  const selected = selectedKeys ?? new Set<string | number>();
  const filteredKeys = processed.map(rowKey);
  const allSelected = filteredKeys.length > 0 && filteredKeys.every((k) => selected.has(k));
  const someSelected = filteredKeys.some((k) => selected.has(k));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    const next = new Set(selected);
    if (allSelected) filteredKeys.forEach((k) => next.delete(k));
    else filteredKeys.forEach((k) => next.add(k));
    onSelectionChange(next);
  };

  const toggleRow = (key: string | number) => {
    if (!onSelectionChange) return;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  };

  // Pagination
  const pageCount = Math.max(1, Math.ceil(processed.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;
  const visible = paginated ? processed.slice(start, start + pageSize) : processed;

  return (
    <div className="bg-panel border border-line rounded-lg overflow-hidden">
      {(searchable || toolbar != null) && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line">
          {searchable && (
            <Input
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="max-w-xs"
            />
          )}
          {toolbar}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-panel-2 border-b border-line">
              {selectable && (
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelected && someSelected;
                    }}
                    onChange={toggleAll}
                    className="accent-accent cursor-pointer"
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={col.sortable ? () => cycleSort(col.key) : undefined}
                  className={`px-3 py-2 font-semibold text-muted uppercase tracking-wider text-[10px] whitespace-nowrap ${ALIGN_CLASS[col.align ?? "left"]} ${
                    col.sortable ? "cursor-pointer select-none hover:text-primary" : ""
                  }`}
                >
                  {col.header}
                  {col.sortable && sortKey === col.key && (
                    <span className="ml-1 text-accent">{sortDir === "asc" ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-line last:border-0">
                    {selectable && (
                      <td className="px-3 py-2.5">
                        <div className="h-3.5 w-3.5 rounded bg-panel-2 animate-pulse" />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td key={col.key} className="px-3 py-2.5">
                        <div className="h-3.5 rounded bg-panel-2 animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : visible.map((row) => {
                  const key = rowKey(row);
                  return (
                    <tr
                      key={key}
                      className={`border-b border-line last:border-0 hover:bg-panel-2/50 ${rowClassName?.(row) ?? ""}`}
                    >
                      {selectable && (
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Select row ${String(key)}`}
                            checked={selected.has(key)}
                            onChange={() => toggleRow(key)}
                            className="accent-accent cursor-pointer"
                          />
                        </td>
                      )}
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          className={`px-3 py-2 text-primary whitespace-nowrap ${ALIGN_CLASS[col.align ?? "left"]} ${col.className ?? ""}`}
                        >
                          {col.render(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!loading && processed.length === 0 && <EmptyState title={emptyTitle} hint={emptyHint} />}
      </div>

      {paginated && !loading && processed.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-line text-[11px] text-muted">
          <span>
            Showing {start + 1}-{Math.min(start + pageSize, processed.length)} of {processed.length}
          </span>
          <div className="flex items-center gap-2">
            <Select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="w-auto"
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              Prev
            </Button>
            <span>
              Page {currentPage} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
