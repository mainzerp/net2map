/**
 * Motion tokens: preset helpers must fall back to opacity-only variants of at
 * most DURATION.fast when prefers-reduced-motion is set.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  DURATION,
  SPRING_CALM,
  dialogPreset,
  fadePreset,
  prefersReducedMotion,
  revealItemVariants,
  slidePreset,
  toastPreset,
  useReducedMotion,
  type MotionPreset,
} from "../theme/motion";

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

const MOVING_KEYS = ["x", "y", "scale", "height"];

function movingKeys(preset: MotionPreset): string[] {
  const targets: unknown[] = [preset.initial, preset.animate, preset.exit];
  return targets
    .filter((t): t is object => typeof t === "object" && t !== null)
    .flatMap((t) => Object.keys(t).filter((k) => MOVING_KEYS.includes(k)));
}

describe("motion tokens", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a calm, non-overshooting spring", () => {
    const { stiffness, damping, mass } = SPRING_CALM;
    // Damping ratio >= 1 means no overshoot.
    expect(damping / (2 * Math.sqrt(stiffness * mass))).toBeGreaterThanOrEqual(1);
    expect([DURATION.fast, DURATION.base, DURATION.slow]).toEqual([0.12, 0.18, 0.24]);
  });

  it("returns moving variants when reduced motion is off", () => {
    mockReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(movingKeys(slidePreset())).toContain("x");
    expect(movingKeys(dialogPreset())).toEqual(expect.arrayContaining(["scale", "y"]));
    expect(movingKeys(toastPreset())).toEqual(expect.arrayContaining(["y", "height"]));
    expect(revealItemVariants().hidden).toMatchObject({ y: 8 });
  });

  it("returns opacity-only variants of at most 120ms when reduced motion is on", () => {
    mockReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);

    for (const preset of [slidePreset(), dialogPreset(), toastPreset(), fadePreset(), fadePreset(undefined, DURATION.slow)]) {
      expect(movingKeys(preset)).toEqual([]);
      expect(preset.initial).toEqual({ opacity: 0 });
      expect(preset.animate).toEqual({ opacity: 1 });
      expect(preset.exit).toEqual({ opacity: 0 });
      expect((preset.transition as { duration: number }).duration).toBeLessThanOrEqual(DURATION.fast);
    }
    const reveal = revealItemVariants();
    expect(reveal.hidden).toEqual({ opacity: 0 });
    expect(reveal.show).toMatchObject({ opacity: 1, transition: { duration: DURATION.fast } });
  });
});
