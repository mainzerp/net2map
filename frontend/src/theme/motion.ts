// ── Motion tokens and presets ────────────────────────────────────────────────
// One calm motion vocabulary for the whole app: short (120-240ms), ease-out,
// small distances (4-16px), and a critically damped spring with no visible
// overshoot (damping ratio ~1.03). Everything should feel like paper sliding.
//
// Reduced motion: the app root sets <MotionConfig reducedMotion="user">, which
// drops transform/layout animations. On top of that every preset helper takes
// a `reduced` flag (defaulting to the current media query) and returns an
// opacity-only variant of at most DURATION.fast, so no preset ever moves,
// scales or collapses content when the user asked for less motion.

import type { MotionProps, Transition, Variants } from "motion/react";
import { prefersReducedMotion } from "../hooks/useReducedMotion";

export { prefersReducedMotion, useReducedMotion } from "../hooks/useReducedMotion";

/** Durations in seconds (motion uses seconds, not milliseconds). */
export const DURATION = {
  fast: 0.12,
  base: 0.18,
  slow: 0.24,
} as const;

/** Standard ease-out curve: quick start, long gentle settle. */
export const EASE_OUT = [0.2, 0, 0, 1] as const;

/** High damping, no overshoot. Used for panels that slide in. */
export const SPRING_CALM = { type: "spring", stiffness: 420, damping: 40, mass: 0.9 } as const satisfies Transition;

/** Stagger between staged reveal items (dashboard sections). */
export const STAGGER = 0.04;

export type MotionPreset = Required<Pick<MotionProps, "initial" | "animate" | "exit" | "transition">>;

const tween = (duration: number): Transition => ({ duration, ease: EASE_OUT });

/** Opacity-only fade used whenever reduced motion is requested. */
export function reducedFade(): MotionPreset {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: DURATION.fast, ease: "linear" },
  };
}

/** Plain fade (backdrops, scrims, content cross-fades). */
export function fadePreset(reduced: boolean = prefersReducedMotion(), duration: number = DURATION.base): MotionPreset {
  if (reduced) return reducedFade();
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: tween(duration),
  };
}

/** Side panel sliding in from an edge (inspector, mobile navigation). */
export function slidePreset(reduced: boolean = prefersReducedMotion(), from: "left" | "right" = "right"): MotionPreset {
  if (reduced) return reducedFade();
  const x = from === "right" ? 16 : -16;
  return {
    initial: { opacity: 0, x },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x },
    transition: { ...SPRING_CALM, opacity: tween(DURATION.base) },
  };
}

/** Centered dialog panel (modal, command palette): settles down and grows in. */
export function dialogPreset(reduced: boolean = prefersReducedMotion()): MotionPreset {
  if (reduced) return reducedFade();
  return {
    initial: { opacity: 0, scale: 0.98, y: -6 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.98, y: -6 },
    transition: tween(DURATION.base),
  };
}

/**
 * Toast: rises 8px while its row opens; on exit it fades and its row
 * collapses so the stack closes the gap smoothly. Overflow is only clipped
 * while the height animates so the resting shadow is not cut off.
 */
export function toastPreset(reduced: boolean = prefersReducedMotion()): MotionPreset {
  if (reduced) return reducedFade();
  return {
    initial: { opacity: 0, y: 8, height: 0, overflow: "hidden" },
    animate: { opacity: 1, y: 0, height: "auto", transitionEnd: { overflow: "visible" } },
    exit: { opacity: 0, height: 0, overflow: "hidden", transition: { ...tween(DURATION.base), opacity: tween(DURATION.fast) } },
    transition: tween(DURATION.slow),
  };
}

/** Page content fade on route change (opacity only, so it is the same in both modes). */
export function pagePreset(): Pick<MotionPreset, "initial" | "animate" | "transition"> {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: DURATION.fast, ease: "linear" },
  };
}

/** Parent variants for a staged reveal; children use `revealItemVariants`. */
export function revealContainerVariants(reduced: boolean = prefersReducedMotion()): Variants {
  return {
    hidden: {},
    show: { transition: reduced ? {} : { staggerChildren: STAGGER } },
  };
}

/** Child variants for a staged reveal: 8px rise plus fade. */
export function revealItemVariants(reduced: boolean = prefersReducedMotion()): Variants {
  if (reduced) {
    return {
      hidden: { opacity: 0 },
      show: { opacity: 1, transition: { duration: DURATION.fast, ease: "linear" } },
    };
  }
  return {
    hidden: { opacity: 0, y: 8 },
    show: { opacity: 1, y: 0, transition: tween(DURATION.slow) },
  };
}
