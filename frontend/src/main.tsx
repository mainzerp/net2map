import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { ToastProvider } from "./components/ToastProvider";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const MapPage = lazy(() => import("./pages/MapPage"));
const DevicesPage = lazy(() => import("./pages/DevicesPage"));
const NetworkPage = lazy(() => import("./pages/NetworkPage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));

const LoadingSpinner = () => (
  <div style={{
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#475569",
    fontSize: 13,
    fontFamily: "'Inter', system-ui, sans-serif",
  }}>
    Loading...
  </div>
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="login" element={<Suspense fallback={<LoadingSpinner />}><LoginPage /></Suspense>} />
          <Route element={<App />}>
            <Route index element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><DashboardPage /></Suspense></ErrorBoundary>} />
            <Route path="map" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><MapPage /></Suspense></ErrorBoundary>} />
            <Route path="devices" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><DevicesPage /></Suspense></ErrorBoundary>} />
            <Route path="network" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><NetworkPage /></Suspense></ErrorBoundary>} />
            <Route path="logs" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><LogsPage /></Suspense></ErrorBoundary>} />
            <Route path="settings" element={<ErrorBoundary><Suspense fallback={<LoadingSpinner />}><SettingsPage /></Suspense></ErrorBoundary>} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>
);
