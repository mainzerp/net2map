/**
 * Tests for the DataTable ui primitive: search, sorting, selection, pagination.
 */
import React, { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DataTable, type DataTableColumn } from "../components/ui";

interface Row {
  id: number;
  name: string;
}

const columns: DataTableColumn<Row>[] = [
  {
    key: "name",
    header: "Name",
    sortable: true,
    sortValue: (r) => r.name.toLowerCase(),
    render: (r) => <span>{r.name}</span>,
  },
];

const rows: Row[] = [
  { id: 1, name: "gamma" },
  { id: 2, name: "alpha" },
  { id: 3, name: "beta" },
];

function bodyRowNames(): string[] {
  return Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.textContent || "");
}

describe("DataTable", () => {
  it("filters rows via the built-in search field", () => {
    function Harness() {
      const [search, setSearch] = useState("");
      return (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          searchable
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search rows"
          searchText={(r) => r.name}
        />
      );
    }

    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText("Search rows"), { target: { value: "bet" } });

    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("gamma")).toBeNull();
  });

  it("sorts rows ascending then descending when clicking a sortable header", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);

    // Initial order is the input order
    expect(bodyRowNames()).toEqual(["gamma", "alpha", "beta"]);

    fireEvent.click(screen.getByText("Name"));
    expect(bodyRowNames()).toEqual(["alpha", "beta", "gamma"]);

    fireEvent.click(screen.getByText("Name"));
    expect(bodyRowNames()).toEqual(["gamma", "beta", "alpha"]);

    // Third click clears the sort
    fireEvent.click(screen.getByText("Name"));
    expect(bodyRowNames()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("supports row selection with select-all across filtered rows", () => {
    const onSelectionChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selectable
        selectedKeys={new Set()}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(screen.getByLabelText("Select all rows"));
    expect(onSelectionChange).toHaveBeenCalledWith(new Set([1, 2, 3]));

    fireEvent.click(screen.getByLabelText("Select row 2"));
    expect(onSelectionChange).toHaveBeenCalledWith(new Set([2]));
  });

  it("paginates client-side with a page-size selector", () => {
    const manyRows: Row[] = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `row-${i + 1}` }));
    render(<DataTable columns={columns} rows={manyRows} rowKey={(r) => r.id} />);

    // Default page size 25
    expect(document.querySelectorAll("tbody tr").length).toBe(25);
    expect(screen.getByText("Showing 1-25 of 30")).toBeTruthy();

    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("Showing 26-30 of 30")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "50" } });
    expect(document.querySelectorAll("tbody tr").length).toBe(30);
  });

  it("renders skeleton rows while loading and an empty state without rows", () => {
    const { container, rerender } = render(
      <DataTable columns={columns} rows={[]} rowKey={(r) => r.id} loading skeletonRows={3} />,
    );
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);

    rerender(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyTitle="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });
});
