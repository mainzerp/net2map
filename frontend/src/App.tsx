import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getStoredToken, getStoredUser, logout, setApiNavigate } from "./api";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import useNetmapStore from "./store";
import { useToast } from "./components/ToastProvider";
import { useTheme } from "./theme/ThemeProvider";
import { useEffect, useMemo, useState, type ReactNode } from "react";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const NAV: NavItem[] = [
  {
    to: "/",
    label: "Dashboard",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </svg>
    ),
  },
  {
    to: "/map",
    label: "Topology",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="5" cy="6" r="2.5" />
        <circle cx="19" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <line x1="7" y1="7.5" x2="10.5" y2="16" />
        <line x1="17" y1="7.5" x2="13.5" y2="16" />
        <line x1="7.5" y1="6" x2="16.5" y2="6" />
      </svg>
    ),
  },
  {
    to: "/devices",
    label: "Devices",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
        <line x1="10" y1="18" x2="10.01" y2="18" />
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="10" y1="6" x2="10.01" y2="6" />
      </svg>
    ),
  },
  {
    to: "/network",
    label: "Network",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="1" y="3" width="22" height="6" rx="1.5" />
        <rect x="1" y="15" width="22" height="6" rx="1.5" />
        <line x1="6" y1="9" x2="6" y2="15" />
        <line x1="18" y1="9" x2="18" y2="15" />
      </svg>
    ),
  },
  {
    to: "/racks",
    label: "Racks",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="5" y="2" width="14" height="20" rx="1.5" />
        <line x1="5" y1="7" x2="19" y2="7" />
        <line x1="5" y1="12" x2="19" y2="12" />
        <line x1="5" y1="17" x2="19" y2="17" />
        <line x1="9" y1="4.5" x2="9.01" y2="4.5" />
        <line x1="9" y1="9.5" x2="9.01" y2="9.5" />
        <line x1="9" y1="14.5" x2="9.01" y2="14.5" />
      </svg>
    ),
  },
  {
    to: "/logs",
    label: "Logs",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="16" y2="17" />
      </svg>
    ),
  },
  {
    to: "/settings",
    label: "Settings",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="2" width="22" height="6" rx="1.5" />
      <rect x="1" y="16" width="22" height="6" rx="1.5" />
      <line x1="6" y1="8" x2="6" y2="16" />
      <line x1="18" y1="8" x2="18" y2="16" />
    </svg>
  );
}

function ThemeToggleButton({ className = "" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-md text-muted hover:text-primary hover:bg-panel-2 transition-colors cursor-pointer ${className}`}
    >
      {isDark ? (
        <svg {...ICON_PROPS}>
          <circle cx="12" cy="12" r="4" />
          <line x1="12" y1="2" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="22" />
          <line x1="2" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="22" y2="12" />
          <line x1="4.9" y1="4.9" x2="7" y2="7" />
          <line x1="17" y1="17" x2="19.1" y2="19.1" />
          <line x1="4.9" y1="19.1" x2="7" y2="17" />
          <line x1="17" y1="7" x2="19.1" y2="4.9" />
        </svg>
      ) : (
        <svg {...ICON_PROPS}>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

function NavItems({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1 px-2">
      {NAV.map(({ to, label, icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          title={collapsed ? label : undefined}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-md text-xs font-semibold transition-colors ${
              collapsed ? "justify-center px-0" : ""
            } ${
              isActive
                ? "text-accent bg-panel-2 border border-line-strong"
                : "text-muted border border-transparent hover:text-primary hover:bg-panel-2"
            }`
          }
        >
          <span className="shrink-0">{icon}</span>
          {!collapsed && <span className="truncate">{label}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

const SIDEBAR_COLLAPSED_KEY = "netmap-sidebar-collapsed";

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const startScan = useNetmapStore((s) => s.startScan);
  const { addToast } = useToast();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

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
      onScan: async () => {
        try {
          await startScan();
          addToast("Scan started", "info");
        } catch {
          addToast("Failed to start scan", "error");
        }
      },
    }),
    [startScan, addToast],
  );

  useKeyboardShortcuts(shortcuts);

  // Redirect to login if no token stored (skip if on login page)
  if (location.pathname !== "/login" && !getStoredToken()) {
    return <Navigate to="/login" replace />;
  }

  const user = getStoredUser();

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        // Storage unavailable - collapse state just will not persist
      }
      return !c;
    });
  }

  const userControls = (
    <div className="flex items-center gap-2">
      {user && (
        <span className="text-muted text-[11px] truncate">
          {user.username} ({user.role})
        </span>
      )}
      <button
        type="button"
        onClick={handleLogout}
        className="px-2.5 py-1 rounded border border-line-strong bg-transparent text-muted text-[11px] hover:text-primary transition-colors cursor-pointer"
      >
        Logout
      </button>
    </div>
  );

  return (
    <div className="flex h-screen bg-surface text-primary overflow-hidden">
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 h-12 flex items-center gap-2 px-3 border-b border-line bg-surface">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted hover:text-primary hover:bg-panel-2 transition-colors cursor-pointer"
        >
          <svg {...ICON_PROPS}>
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <NavLink to="/" className="flex items-center gap-2 no-underline">
          <BrandMark />
          <span className="text-primary font-bold text-[15px]">NetMap</span>
        </NavLink>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggleButton />
          {userControls}
        </div>
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-56 bg-surface border-r border-line flex flex-col py-3">
            <div className="flex items-center gap-2 px-4 pb-3">
              <BrandMark />
              <span className="text-primary font-bold text-[15px]">NetMap</span>
            </div>
            <NavItems collapsed={false} onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside
        className={`hidden md:flex flex-col shrink-0 border-r border-line bg-surface transition-[width] duration-150 ${
          collapsed ? "w-14" : "w-52"
        }`}
      >
        <NavLink
          to="/"
          className={`flex items-center gap-2 no-underline h-14 shrink-0 ${collapsed ? "justify-center" : "px-4"}`}
        >
          <BrandMark />
          {!collapsed && <span className="text-primary font-bold text-[15px]">NetMap</span>}
        </NavLink>

        <div className="flex-1 overflow-y-auto py-2">
          <NavItems collapsed={collapsed} />
        </div>

        <div className={`shrink-0 border-t border-line p-2 flex ${collapsed ? "flex-col items-center gap-1" : "items-center gap-1"}`}>
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted hover:text-primary hover:bg-panel-2 transition-colors cursor-pointer"
          >
            <svg {...ICON_PROPS}>
              {collapsed ? (
                <polyline points="9 18 15 12 9 6" />
              ) : (
                <polyline points="15 18 9 12 15 6" />
              )}
            </svg>
          </button>
          <ThemeToggleButton />
          {!collapsed && <div className="ml-auto">{userControls}</div>}
        </div>
        {collapsed && <div className="shrink-0 px-2 pb-2 flex justify-center">{userControls}</div>}
      </aside>

      {/* Page content */}
      <main className="flex-1 min-w-0 min-h-0 overflow-y-auto pt-12 md:pt-0">
        <div className="h-full p-4">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
