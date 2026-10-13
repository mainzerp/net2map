/**
 * Tests for the dashboard AttentionCard: offline device rows open the shared
 * inspector drawer (`?inspect=device:<id>`), other rows keep navigating.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithRouter } from "./test-utils";
import { AttentionCard } from "../features/dashboard/AttentionCard";
import type { SwitchClass, TopologyNode } from "../types";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{decodeURIComponent(location.pathname + location.search)}</div>;
}

function makeNode(partial: Partial<TopologyNode>): TopologyNode {
  return {
    id: 0,
    ip: "10.0.0.1",
    hostname: "sw",
    sys_name: "sw",
    vendor: "generic",
    model: "",
    mac: "",
    rack_id: 1,
    class_id: null,
    model_id: null,
    x: null,
    y: null,
    map_x: 0,
    map_y: 0,
    ignored: false,
    role: "",
    ports_per_row: 24,
    total_ports: 0,
    ports: [],
    ...partial,
  };
}

const NODES: TopologyNode[] = [
  makeNode({ id: 1, ip: "10.0.0.1", sys_name: "core-1", ping_status: "online" }),
  makeNode({ id: 7, ip: "10.0.0.7", sys_name: "edge-7", ping_status: "offline" }),
  makeNode({ id: 9, ip: "10.0.0.9", sys_name: "loose-9", ping_status: "online", rack_id: null }),
];

function renderCard(route = "/") {
  return renderWithRouter(
    <>
      <AttentionCard nodes={NODES} />
      <LocationProbe />
    </>,
    { route },
  );
}

describe("AttentionCard", () => {
  it("opens the inspector for an offline device row on click", () => {
    renderCard();
    const row = screen.getByRole("button", { name: /Open details for edge-7/ });
    expect(row.querySelector('[data-testid="attention-open-chevron"]')).toBeTruthy();

    fireEvent.click(row);
    expect(screen.getByTestId("location").textContent).toBe("/?inspect=device:7");
  });

  it("keeps existing params when opening the inspector", () => {
    renderCard("/?foo=bar");
    fireEvent.click(screen.getByRole("button", { name: /Open details for edge-7/ }));
    expect(screen.getByTestId("location").textContent).toBe("/?foo=bar&inspect=device:7");
  });

  it("keeps navigation for non-device rows", () => {
    renderCard();
    const row = screen.getByRole("button", { name: /not assigned to a rack/ });
    expect(row.querySelector('[data-testid="attention-open-chevron"]')).toBeNull();

    fireEvent.click(row);
    expect(screen.getByTestId("location").textContent).toBe("/network");
  });

  it("does not count unracked devices whose class allows outside-rack placement", () => {
    const classes: SwitchClass[] = [
      { id: 3, label: "Access", color: "#000000", description: "", allow_outside_rack: true },
      { id: 4, label: "Core", color: "#000000", description: "", allow_outside_rack: false },
    ];
    const nodes = [
      makeNode({ id: 20, ip: "10.0.0.20", rack_id: null, class_id: 3 }),
      makeNode({ id: 21, ip: "10.0.0.21", rack_id: null, class_id: 4 }),
      makeNode({ id: 22, ip: "10.0.0.22", rack_id: null, class_id: null }),
    ];
    renderWithRouter(<AttentionCard nodes={nodes} classes={classes} />);
    expect(screen.getByRole("button", { name: /2 switches not assigned to a rack/ })).toBeTruthy();
  });

  it("hides the rack row when every unracked device may stay outside a rack", () => {
    const classes: SwitchClass[] = [
      { id: 3, label: "Access", color: "#000000", description: "", allow_outside_rack: true },
    ];
    renderWithRouter(
      <AttentionCard nodes={[makeNode({ id: 20, rack_id: null, class_id: 3 })]} classes={classes} />,
    );
    expect(screen.queryByRole("button", { name: /not assigned to a rack/ })).toBeNull();
  });
});
