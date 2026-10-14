import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeviceAssignment } from "../components/settings/shared";
import type { TopologyNode } from "../types";

function node(id: number, sys_name: string, ip: string, vendor = "", model = ""): TopologyNode {
  return {
    id, ip, hostname: "", sys_name, vendor, model, mac: "", rack_id: null, class_id: null, model_id: null,
    x: null, y: null, map_x: 0, map_y: 0, ignored: false, role: "", ports_per_row: 0, total_ports: 0, ports: [],
  };
}

const DEVICES = [
  node(1, "core-sw1", "10.0.1.1", "Aruba", "6300M"),
  node(2, "edge-sw2", "10.0.2.5", "Cisco", "C9200"),
  node(3, "dist-sw3", "10.0.1.9", "Aruba", "6100"),
];

// Stateful harness: assigning moves a device from available to assigned, like
// the tabs do after the mutation and refetch.
function Harness({ onAssign }: { onAssign?: (id: number) => void }) {
  const [assignedIds, setAssignedIds] = useState<number[]>([]);
  return (
    <DeviceAssignment
      assigned={DEVICES.filter((d) => assignedIds.includes(d.id))}
      available={DEVICES.filter((d) => !assignedIds.includes(d.id))}
      onAssign={(id) => { onAssign?.(id); setAssignedIds((p) => [...p, id]); }}
      onUnassign={(id) => setAssignedIds((p) => p.filter((x) => x !== id))}
    />
  );
}

describe("DeviceAssignment", () => {
  it("renders the assigned devices header", () => {
    render(<Harness />);
    expect(screen.getByText("ASSIGNED DEVICES (0)")).toBeTruthy();
  });

  it("filters by IP substring and assigns on click, keeping focus", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<Harness onAssign={onAssign} />);
    const input = screen.getByRole("combobox", { name: "Assign device" });
    await user.click(input);
    await user.type(input, "10.0.1");
    const list = screen.getByRole("listbox");
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("core-sw1"),
      expect.stringContaining("dist-sw3"),
    ]);
    await user.click(options[0]);
    expect(onAssign).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("ASSIGNED DEVICES (1)")).toBeTruthy();
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  });

  it("supports arrow keys, Enter to assign and Escape to clear", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<Harness onAssign={onAssign} />);
    const input = screen.getByRole("combobox", { name: "Assign device" });
    await user.click(input);
    await user.type(input, "aruba");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onAssign).toHaveBeenCalledWith(3);
    await user.keyboard("{Enter}");
    expect(onAssign).toHaveBeenLastCalledWith(1);
    expect(screen.getByText("ASSIGNED DEVICES (2)")).toBeTruthy();
    expect(screen.getByText("No matching devices")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  });

  it("shows a refine hint when matches exceed the cap", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 60 }, (_, i) => node(i + 1, `sw-${String(i).padStart(2, "0")}`, `10.9.0.${i}`));
    render(<DeviceAssignment assigned={[]} available={many} onAssign={() => {}} onUnassign={() => {}} />);
    await user.click(screen.getByRole("combobox", { name: "Assign device" }));
    expect(screen.getByText("10 more, refine search")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(50);
  });

  it("hides a picked device until the available list refreshes", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<DeviceAssignment assigned={[]} available={DEVICES} onAssign={onAssign} onUnassign={() => {}} />);
    const input = screen.getByRole("combobox", { name: "Assign device" });
    await user.click(input);
    await user.keyboard("{Enter}");
    expect(onAssign).toHaveBeenCalledWith(1);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});
