import { NavLink, Outlet, useLocation } from "react-router-dom";

const NAV = [
  { to: "/",         label: "Dashboard" },
  { to: "/map",      label: "Topology" },
  { to: "/logs",     label: "Logs" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const location = useLocation();

  return (
    <>
      {/* Global styles */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { height: 100%; margin: 0; overflow: hidden; }
        body { background: #020817; font-family: 'Inter', system-ui, sans-serif; font-size: 12px; }
        [style*="font-size: 8px"],
        [style*="font-size: 9px"],
        [style*="font-size: 10px"],
        [style*="font-size: 11px"] { font-size: 12px !important; }
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
      </header>

      {/* Page content */}
      <main style={{ flex: 1, height: "calc(100vh - 48px)", overflow: "auto" }}>
        <Outlet />
      </main>
    </>
  );
}
