import { create } from "zustand";

export type Theme = "dark" | "light";

const STORAGE_KEY = "netmap-theme";

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage unavailable (e.g. private mode) - theme still applies for the session
    }
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
}));

// Apply the stored theme immediately on module load to avoid a flash of the
// wrong theme before React mounts.
applyTheme(useTheme.getState().theme);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
