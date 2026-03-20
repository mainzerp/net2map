import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App.jsx";
import DashboardPage from "./pages/DashboardPage";
import MapPage from "./pages/MapPage";
import DevicesPage from "./pages/DevicesPage";
import NetworkPage from "./pages/NetworkPage";
import LogsPage from "./pages/LogsPage";
import SettingsPage from "./pages/SettingsPage";
import LoginPage from "./pages/LoginPage";
import ErrorBoundary from "./components/ErrorBoundary";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route element={<App />}>
          <Route index element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
          <Route path="map" element={<ErrorBoundary><MapPage /></ErrorBoundary>} />
          <Route path="devices" element={<ErrorBoundary><DevicesPage /></ErrorBoundary>} />
          <Route path="network" element={<ErrorBoundary><NetworkPage /></ErrorBoundary>} />
          <Route path="logs" element={<ErrorBoundary><LogsPage /></ErrorBoundary>} />
          <Route path="settings" element={<ErrorBoundary><SettingsPage /></ErrorBoundary>} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
