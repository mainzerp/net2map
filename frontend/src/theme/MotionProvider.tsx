import type { ReactNode } from "react";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { DURATION, EASE_OUT } from "./motion";

/**
 * App-wide motion setup: only the small domAnimation feature bundle is loaded
 * (components use `m.*`, not `motion.*`), the default transition is the calm
 * ease-out, and reducedMotion="user" drops transform animations for users who
 * prefer reduced motion. `strict` makes accidental `motion.*` usage throw.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user" transition={{ duration: DURATION.base, ease: EASE_OUT }}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
