import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getStoredToken, getStoredUser, logout, setApiNavigate } from "./api";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import useNetmapStore from "./store";
import { useToast } from "./components/ToastProvider";
import { useEffect, useMemo } from "react";

interface NavItem {
  to: string;
  label: string;
}

const NAV: NavItem[] = [
  { to: "/",         label: "Dashboard" },
  { to: "/map",      label: "Topology" },
  { to: "/devices",  label: "Devices" },
  { to: "/network",  label: "Network" },
  { to: "/logs",     label: "Logs" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const startScan = useNetmapStore(s => s.startScan);
  const { addToast } = useToast();

  useEffect(() => {
    setApiNavigate(navigate);
  }, [navigate]);

  const shortcuts = useMemo(() => ({
    onEscape: () => {
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
  }), [startScan, addToast]);

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

  return (
    <>
      {/* Global styles */}
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { height: 100%; margin: 0; overflow: hidden; }
        body { background: #020817; font-family: 'Inter', system-ui, sans-serif; font-size: 12px; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #334155; }
      `}</style>

      {/* Header */}
      <header style={{
        height: 48,
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid #0f172a",
        backgroundColor: "#020817",
        padding: "0 20px",
        flexShrink: 0,
        gap: 24,
      }}>
        {/* Brand */}
        <NavLink to="/" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="2" width="22" height="6" rx="1.5" />
            <rect x="1" y="16" width="22" height="6" rx="1.5" />
            <line x1="6"  y1="8"  x2="6"  y2="16" />
            <line x1="18" y1="8"  x2="18" y2="16" />
          </svg>
          <span style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 15, fontFamily: "'Inter', system-ui, sans-serif" }}>
            NetMap
          </span>
        </NavLink>

        {/* Nav tabs */}
        <nav style={{ display: "flex", gap: 4, marginLeft: 8 }}>
          {NAV.map(({ to, label }) => {
            const isActive = to === "/"
              ? location.pathname === "/"
              : location.pathname.startsWith(to);
            return (
              <NavLink
                key={to}
                to={to}
                style={{
                  textDecoration: "none",
                  padding: "6px 14px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "'Inter', system-ui, sans-serif",
                  color: isActive ? "#22d3ee" : "#475569",
                  backgroundColor: isActive ? "#083344" : "transparent",
                  border: `1px solid ${isActive ? "#164e63" : "transparent"}`,
                  transition: "all 0.15s",
                }}
              >
                {label}
              </NavLink>
            );
          })}
        </nav>

        {/* User info + Logout */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {user && (
            <span style={{ color: "#64748b", fontSize: 11, fontFamily: "'Inter', system-ui, sans-serif" }}>
              {user.username} ({user.role})
            </span>
          )}
          <button
            onClick={handleLogout}
            style={{
              padding: "4px 10px",
              borderRadius: 5,
              border: "1px solid #334155",
              backgroundColor: "transparent",
              color: "#94a3b8",
              fontSize: 11,
              cursor: "pointer",
              fontFamily: "'Inter', system-ui, sans-serif",
            }}
          >
            Logout
          </button>
        </div>
      </header>

      {/* Page content */}
      <main style={{ flex: 1, height: "calc(100vh - 48px)", overflow: "auto" }}>
        <Outlet />
      </main>
    </>
  );
}
