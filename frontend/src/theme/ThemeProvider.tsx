import { create } from "zustand";

export type Theme = "dark" | "light";

const STORAGE_KEY = "netmap-theme";

// Light ("paper") is the default; only an explicit stored "dark" preference
// switches to the dark theme. Stored "light"/"dark" values keep working.
function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

// index.css styles :root as light and overrides tokens under
// [data-theme="dark"]; the attribute is always set so CSS and React Flow's
// colorMode stay in sync.
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
