import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Container,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Network,
  ScrollText,
  Search,
  Server,
  Settings,
  Sun,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { getStoredToken, getStoredUser, logout, setApiNavigate } from "./api";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useStartScan } from "./hooks/useStartScan";
import { useToast } from "./components/ToastProvider";
import { useTheme } from "./theme/ThemeProvider";
import CommandPalette from "./features/command-palette/CommandPalette";
import { paletteShortcutLabel, usePaletteStore } from "./features/command-palette/paletteStore";
import InspectorDrawer from "./features/inspector/InspectorDrawer";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";
import { DURATION, EASE_OUT, fadePreset, pagePreset, slidePreset, useReducedMotion } from "./theme/motion";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const ICON_SIZE = 16;
const ICON_STROKE = 1.75;

const NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/map", label: "Topology", icon: Waypoints },
  { to: "/devices", label: "Devices", icon: Server },
  { to: "/network", label: "Network", icon: Network },
  { to: "/racks", label: "Racks", icon: Container },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings },
];

// "sidebar": controls on the ink-navy sidebar; "surface": controls on the page
// surface (mobile top bar).
type ChromeTone = "sidebar" | "surface";

const ICON_BUTTON_TONE: Record<ChromeTone, string> = {
  sidebar: "text-sidebar-muted hover:text-sidebar-text hover:bg-sidebar-hover",
  surface: "text-muted hover:text-primary hover:bg-panel-2",
};

function BrandMark({ size = 20, className = "text-accent" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="1" y="2" width="22" height="6" rx="1.5" />
      <rect x="1" y="16" width="22" height="6" rx="1.5" />
      <line x1="6" y1="8" x2="6" y2="16" />
      <line x1="18" y1="8" x2="18" y2="16" />
    </svg>
  );
}

function ThemeToggleButton({ tone = "surface", className = "" }: { tone?: ChromeTone; className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const Icon = isDark ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-control transition-colors cursor-pointer ${ICON_BUTTON_TONE[tone]} ${className}`}
    >
      <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
    </button>
  );
}

// Sidebar label that fades in when the sidebar expands. `animate` is false
// until the user toggles the sidebar, so labels do not fade on page load.
function SidebarLabel({ animate, className, children }: { animate: boolean; className?: string; children: ReactNode }) {
  return (
    <m.span
      className={className}
      initial={animate ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: DURATION.base, ease: EASE_OUT, delay: DURATION.fast / 2 }}
    >
      {children}
    </m.span>
  );
}

// Opens the command palette; the kbd hint mirrors the Ctrl/Cmd+K shortcut.
function SearchTrigger({ collapsed, animateLabels }: { collapsed: boolean; animateLabels: boolean }) {
  const setOpen = usePaletteStore((s) => s.setOpen);
  const shortcut = paletteShortcutLabel();
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={`Search (${shortcut})`}
      aria-label={`Search (${shortcut})`}
      aria-keyshortcuts="Control+K Meta+K"
      className={`flex items-center gap-2 rounded-control text-xs transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent text-sidebar-muted hover:text-sidebar-text hover:bg-sidebar-hover ${
        collapsed ? "justify-center w-8 h-8 mx-auto" : "w-full px-3 py-2 border border-sidebar-hover"
      }`}
    >
      <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0" aria-hidden="true" />
      {!collapsed && (
        <SidebarLabel animate={animateLabels} className="flex-1 min-w-0 flex items-center gap-2">
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-sidebar-hover text-sidebar-muted">{shortcut}</kbd>
        </SidebarLabel>
      )}
    </button>
  );
}

function NavItems({
  collapsed,
  animateLabels = false,
  onNavigate,
}: {
  collapsed: boolean;
  animateLabels?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Main navigation" className="flex flex-col gap-0.5 px-2">
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          title={collapsed ? label : undefined}
          aria-label={collapsed ? label : undefined}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-control text-xs font-medium no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              collapsed ? "justify-center px-0" : ""
            } ${
              isActive
                ? "text-sidebar-text bg-sidebar-hover shadow-[inset_3px_0_var(--accent)]"
                : "text-sidebar-muted hover:text-sidebar-text hover:bg-sidebar-hover"
            }`
          }
        >
          <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0" aria-hidden="true" />
          {!collapsed && (
            <SidebarLabel animate={animateLabels} className="truncate">
              {label}
            </SidebarLabel>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

const SIDEBAR_COLLAPSED_KEY = "net2map-sidebar-collapsed";

/** Page transition key: "/settings/credentials" and "/settings/snmp" share "settings". */
function pageKey(pathname: string): string {
  return pathname.split("/")[1] ?? "";
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const startScan = useStartScan();
  const openPalette = usePaletteStore((s) => s.setOpen);
  const { addToast } = useToast();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Labels only fade after an explicit collapse toggle, never on first paint.
  const [animateLabels, setAnimateLabels] = useState(false);
  const reduced = useReducedMotion();
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!drawerOpen || !drawerRef.current) return;
    const panel = drawerRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = Array.from(panel.querySelectorAll<HTMLElement>("button, a[href]"));
    controls[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
      }
      if (event.key !== "Tab") return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [drawerOpen]);

  useEffect(() => {
    setApiNavigate(navigate);
  }, [navigate]);

  // Close the mobile drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const shortcuts = useMemo(
    () => ({
      onEscape: () => {
        setDrawerOpen(false);
        // blur any focused element to close dropdowns / modals
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      },
      onScan: () => {
        void startScan();
      },
    }),
    [startScan],
  );

  useKeyboardShortcuts(shortcuts);

  // Redirect to login if no token stored (skip if on login page)
  if (location.pathname !== "/login" && !getStoredToken()) {
    return <Navigate to="/login" replace />;
  }

  const user = getStoredUser();

  function handleLogout() {
    void logout().then(revoked => {
      if (!revoked) addToast("Signed out locally. Server session revocation failed; the token may remain valid until it expires.", "error");
    });
    navigate("/login", { replace: true });
  }

  function toggleCollapsed() {
    setAnimateLabels(true);
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        // Storage unavailable - collapse state just will not persist
      }
      return !c;
    });
  }

  const renderUserControls = (tone: ChromeTone) => (
    <div className="flex min-w-0 items-center gap-2">
      {user && (
        <span
          title={`${user.username} (${user.role})`}
          className={`text-[11px] truncate max-w-28 ${tone === "sidebar" ? "text-sidebar-muted" : "text-muted"} ${collapsed && tone === "sidebar" ? "hidden" : "hidden sm:inline"}`}
        >
          {user.username} ({user.role})
        </span>
      )}
      <button
        type="button"
        onClick={handleLogout}
        title="Logout"
        aria-label={collapsed && tone === "sidebar" ? "Logout" : undefined}
        className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-1.5 rounded-control border bg-transparent text-[11px] transition-colors cursor-pointer ${
          tone === "sidebar"
            ? "border-sidebar-hover text-sidebar-muted hover:text-sidebar-text hover:bg-sidebar-hover"
            : "border-line-strong text-muted hover:text-primary hover:bg-panel-2"
        }`}
      >
        <LogOut size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {!(collapsed && tone === "sidebar") && "Logout"}
      </button>
    </div>
  );

  return (
    <div className="flex h-dvh bg-surface text-primary overflow-hidden">
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 h-12 flex items-center gap-2 px-3 border-b border-line bg-surface">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          aria-controls="mobile-navigation"
          className={`inline-flex items-center justify-center w-8 h-8 rounded-control transition-colors cursor-pointer ${ICON_BUTTON_TONE.surface}`}
        >
          <Menu size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
        <NavLink to="/" className="flex items-center gap-2 no-underline">
          <BrandMark />
          <span className="text-primary font-semibold text-[15px] tracking-tight">Net2Map</span>
        </NavLink>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => openPalette(true)}
            aria-label="Search"
            title="Search"
            className={`inline-flex items-center justify-center w-8 h-8 rounded-control transition-colors cursor-pointer ${ICON_BUTTON_TONE.surface}`}
          >
            <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
          <ThemeToggleButton />
          {renderUserControls("surface")}
        </div>
      </div>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
        <div key="mobile-navigation" className="md:hidden fixed inset-0 z-40">
          <m.div {...fadePreset(reduced)} className="absolute inset-0 bg-scrim" onClick={() => setDrawerOpen(false)} />
          <m.aside {...slidePreset(reduced, "left")} ref={drawerRef} id="mobile-navigation" role="dialog" aria-modal="true" aria-label="Navigation" className="absolute left-0 top-0 bottom-0 w-56 bg-sidebar text-sidebar-text flex flex-col py-3 overflow-y-auto shadow-raised">
            <div className="flex items-center gap-2 px-4 pb-3">
              <BrandMark className="text-sidebar-text" />
              <span className="text-sidebar-text font-semibold text-[15px] tracking-tight">Net2Map</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation"
                className={`ml-auto inline-flex items-center justify-center w-8 h-8 rounded-control cursor-pointer ${ICON_BUTTON_TONE.sidebar}`}
              >
                <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
            </div>
            <NavItems collapsed={false} onNavigate={() => setDrawerOpen(false)} />
          </m.aside>
        </div>
        )}
      </AnimatePresence>

      {/* Desktop sidebar: ink navy in both themes */}
      <aside
        className={`hidden md:flex flex-col shrink-0 overflow-hidden bg-sidebar text-sidebar-text transition-[width] duration-180 ease-out motion-reduce:transition-none ${
          collapsed ? "w-14" : "w-52"
        }`}
      >
        <NavLink
          to="/"
          aria-label="Net2Map dashboard"
          className={`flex items-center gap-2 no-underline h-14 shrink-0 ${collapsed ? "justify-center" : "px-4"}`}
        >
          <BrandMark className="text-sidebar-text" />
          {!collapsed && (
            <SidebarLabel animate={animateLabels} className="text-sidebar-text font-semibold text-[15px] tracking-tight whitespace-nowrap">
              Net2Map
            </SidebarLabel>
          )}
        </NavLink>

        <div className={`shrink-0 pb-2 ${collapsed ? "px-0" : "px-2"}`}>
          <SearchTrigger collapsed={collapsed} animateLabels={animateLabels} />
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <NavItems collapsed={collapsed} animateLabels={animateLabels} />
        </div>

        <div className={`shrink-0 border-t border-sidebar-hover p-2 flex ${collapsed ? "flex-col items-center gap-1" : "items-center gap-1"}`}>
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`inline-flex items-center justify-center w-8 h-8 rounded-control transition-colors cursor-pointer ${ICON_BUTTON_TONE.sidebar}`}
          >
            {collapsed ? (
              <ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : (
              <ChevronLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            )}
          </button>
          <ThemeToggleButton tone="sidebar" />
        </div>
        <div className={`shrink-0 px-2 pb-3 flex ${collapsed ? "justify-center" : "justify-start"}`}>{renderUserControls("sidebar")}</div>
      </aside>

      {/* Page content */}
      <main className="flex-1 min-w-0 min-h-0 overflow-y-auto pt-12 md:pt-0">
        {/* Quiet fade on route change. Keyed by the first path segment, so
            search-param changes (opening the inspector) and settings tab
            switches do not re-animate or remount the page. No exit animation,
            to avoid layout jumps between pages. */}
        <m.div key={pageKey(location.pathname)} {...pagePreset()} className="h-full p-4">
          <Outlet />
        </m.div>
      </main>

      <InspectorDrawer />
      <CommandPalette />
    </div>
  );
}
