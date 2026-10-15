import "./storageMigration";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { SESSION_CHANGED_EVENT } from "./api";
import ErrorBoundary from "./components/ErrorBoundary";
import LegacyRedirect from "./components/LegacyRedirect";
import { ToastProvider } from "./components/ToastProvider";
import { ThemeProvider } from "./theme/ThemeProvider";
import { MotionProvider } from "./theme/MotionProvider";
import { Spinner } from "./components/ui";
import "./index.css";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const MapPage = lazy(() => import("./pages/MapPage"));
const DevicesPage = lazy(() => import("./pages/DevicesPage"));
const RacksPage = lazy(() => import("./pages/RacksPage"));
const NetworkPage = lazy(() => import("./pages/NetworkPage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
// Design-system review page; reachable by URL only (not in the nav).
const StyleguidePage = lazy(() => import("./pages/StyleguidePage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// Authentication boundaries must also remove cached privileged query results.
window.addEventListener(SESSION_CHANGED_EVENT, () => queryClient.clear());

const LoadingSpinner = () => (
  <div className="flex items-center justify-center h-full text-muted text-[13px] gap-2">
    <Spinner size={14} />
    Loading...
  </div>
);

function lazyPage(element: React.ReactNode) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>{element}</Suspense>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <MotionProvider>
            <ToastProvider>
              <Routes>
                <Route path="login" element={<Suspense fallback={<LoadingSpinner />}><LoginPage /></Suspense>} />
                <Route element={<App />}>
                  <Route index element={lazyPage(<DashboardPage />)} />
                  <Route path="map" element={lazyPage(<MapPage />)} />
                  <Route path="endpoints" element={lazyPage(<DevicesPage />)} />
                  {/* The endpoints page lived at /devices before v4.6.0. */}
                  <Route path="devices" element={<LegacyRedirect to="/endpoints" />} />
                  <Route path="racks" element={lazyPage(<RacksPage />)} />
                  <Route path="network" element={lazyPage(<NetworkPage />)} />
                  <Route path="logs" element={lazyPage(<LogsPage />)} />
                  <Route path="settings" element={<Navigate to="/settings/credentials" replace />} />
                  <Route path="settings/:tab" element={lazyPage(<SettingsPage />)} />
                  <Route path="styleguide" element={lazyPage(<StyleguidePage />)} />
                </Route>
              </Routes>
            </ToastProvider>
          </MotionProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
