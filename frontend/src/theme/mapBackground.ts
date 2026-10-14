// Map canvas background color helpers.
//
// The backend seeds map_bg_color with the legacy dark-theme surface color
// "#020817" (alembic 005, database.py, shared/file_settings.py). The frontend
// treats that legacy default as "follow the theme" so a fresh install renders
// the canvas on the current theme surface instead of a hardcoded dark navy.
// Any other value is a user-chosen data color and is honored as-is.
export const THEME_MAP_BG_SENTINEL = "#020817";

// Plain white canvas preset for floor plans (a user data color, not UI chrome).
export const MAP_BG_WHITE = "#ffffff";

// Resolve a stored bg_color to the value the canvas should use. An empty string
// means "use var(--surface)" (TopologyCanvas falls back to the theme surface).
export function resolveMapBgColor(stored: string | null | undefined): string {
  if (!stored) return "";
  return stored.toLowerCase() === THEME_MAP_BG_SENTINEL ? "" : stored;
}
