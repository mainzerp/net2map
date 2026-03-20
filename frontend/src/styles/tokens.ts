/**
 * Design tokens -- single source of truth for colors, spacing, radii, and typography.
 */
export const colors = {
  bg: {
    base: "#020817",
    panel: "#0a0e18",
    card: "#0f172a",
    surface: "#1e293b",
    hover: "#334155",
  },
  text: {
    primary: "#e2e8f0",
    secondary: "#94a3b8",
    muted: "#64748b",
    dark: "#475569",
  },
  accent: {
    cyan: "#22d3ee",
    blue: "#38bdf8",
    purple: "#a78bfa",
    green: "#22c55e",
    yellow: "#fbbf24",
    orange: "#fb923c",
    red: "#f87171",
    pink: "#f472b6",
  },
  status: {
    online: "#22c55e",
    offline: "#f87171",
    warning: "#fbbf24",
  },
  border: {
    default: "#1e293b",
    hover: "#334155",
    focus: "#22d3ee",
  },
} as const;

export const radii = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
  xxl: 12,
} as const;

export const spacing = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
} as const;

export const fonts = {
  base: "'Inter', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', monospace",
} as const;

export const shadows = {
  card: "0 2px 8px rgba(0,0,0,0.3)",
  modal: "0 8px 32px rgba(0,0,0,0.5)",
} as const;
