// Global vitest setup. Motion animations are skipped in jsdom so enter/exit
// transitions resolve immediately and tests stay deterministic.
import { MotionGlobalConfig } from "motion/react";

MotionGlobalConfig.skipAnimations = true;
