import { create } from "zustand";

interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/** Open state of the global command palette (shared by triggers and shortcuts). */
export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

/** True on Apple platforms, where the palette shortcut is Cmd+K. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
}

export function paletteShortcutLabel(): string {
  return isApplePlatform() ? "Cmd K" : "Ctrl K";
}
