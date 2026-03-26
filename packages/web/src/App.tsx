import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/auth.js";
import { AppLayout } from "./components/sidebar/AppLayout.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { QueryPage } from "./pages/QueryPage.js";
import { CopilotPage } from "./pages/CopilotPage.js";
import { LoginPage } from "./pages/LoginPage.js";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/copilot" replace />} />
        <Route path="/copilot" element={<CopilotPage />} />
        <Route path="/dashboards" element={<DashboardPage />} />
        <Route path="/dashboards/:id" element={<DashboardPage />} />
        <Route path="/queries" element={<QueryPage />} />
        <Route path="/queries/:id" element={<QueryPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
