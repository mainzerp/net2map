/**
 * Sparkline primitive: accessible SVG, gaps for null values, baseline.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sparkline, sparklineGeometry } from "../components/ui";

describe("sparklineGeometry", () => {
  it("splits runs at null values and keeps isolated points as dots", () => {
    const geo = sparklineGeometry([1, 2, null, 3, 4, null, 5], 20);
    expect(geo.lines).toHaveLength(2);
    expect(geo.areas).toHaveLength(2);
    expect(geo.dots).toHaveLength(1);
    expect(geo.lines[0].startsWith("M0,")).toBe(true);
  });

  it("returns nothing for all-null input", () => {
    const geo = sparklineGeometry([null, null], 20);
    expect(geo.lines).toEqual([]);
    expect(geo.dots).toEqual([]);
    expect(geo.baselineY).toBeNull();
  });

  it("maps higher values to smaller y and includes the baseline in the domain", () => {
    const geo = sparklineGeometry([0, 10], 20, 5);
    expect(geo.lines[0]).toBe("M0,19 L100,1");
    expect(geo.baselineY).toBe(10);
  });
});

describe("Sparkline", () => {
  it("renders an accessible image with one path per segment", () => {
    render(<Sparkline values={[1, 2, null, 3, 4]} ariaLabel="RTT trend" tone="warning" baseline={2} area />);
    const img = screen.getByRole("img", { name: "RTT trend" });
    expect(img.getAttribute("class")).toContain("text-warning");
    expect(screen.getAllByTestId("sparkline-line")).toHaveLength(2);
    expect(screen.getByTestId("sparkline-baseline")).toBeTruthy();
  });

  it("renders an empty chart without paths", () => {
    render(<Sparkline values={[]} ariaLabel="Empty" />);
    expect(screen.getByRole("img", { name: "Empty" })).toBeTruthy();
    expect(screen.queryAllByTestId("sparkline-line")).toHaveLength(0);
  });
});
