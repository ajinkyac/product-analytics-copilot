import { Outlet } from "react-router-dom";
import { useUIStore } from "../../stores/ui.js";
import { Sidebar } from "./Sidebar.js";
import { clsx } from "clsx";

export function AppLayout() {
  const collapsed = useUIStore((s) => s.sidebarCollapsed);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      <Sidebar />
      <main
        className={clsx(
          "flex-1 overflow-y-auto transition-all duration-200",
          collapsed ? "ml-16" : "ml-60"
        )}
      >
        <div className="min-h-full p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
