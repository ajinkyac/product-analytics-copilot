import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/api.js";
import { useUIStore } from "../stores/ui.js";
import type { Dashboard } from "@copilot/shared";

export function DashboardPage() {
  const activeProjectId = useUIStore((s) => s.activeProjectId);

  const { data, isLoading } = useQuery<Dashboard[]>({
    queryKey: ["dashboards", activeProjectId],
    queryFn: async () => {
      const res = await apiClient.get<{ data: Dashboard[] }>(`/v1/dashboards?projectId=${activeProjectId}`);
      return res.data.data;
    },
    enabled: !!activeProjectId,
  });

  if (!activeProjectId) {
    return (
      <div className="text-center py-20 text-sm text-gray-500">
        Select a project to view dashboards.
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-100">Dashboards</h1>
        <button className="btn-primary text-xs">New dashboard</button>
      </div>

      {isLoading && (
        <div className="text-center py-12 text-sm text-gray-500">Loading dashboards…</div>
      )}

      {!isLoading && (!data || data.length === 0) && (
        <div className="text-center py-16">
          <div className="w-12 h-12 mx-auto rounded-xl bg-gray-800 flex items-center justify-center mb-4 text-2xl">
            📊
          </div>
          <h2 className="text-base font-medium text-gray-300 mb-1">No dashboards yet</h2>
          <p className="text-sm text-gray-600">
            Save a query from the Copilot and pin it to a new dashboard.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map((dashboard) => (
          <div
            key={dashboard.id}
            className="glass-panel p-4 hover:border-gray-700 transition-colors cursor-pointer group"
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">{dashboard.emoji}</span>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-gray-100 group-hover:text-white transition-colors">
                  {dashboard.title}
                </h3>
                {dashboard.description && (
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{dashboard.description}</p>
                )}
                <p className="text-xs text-gray-600 mt-2">
                  {dashboard.widgets?.length ?? 0} widgets
                  {dashboard.isPublic && (
                    <span className="ml-2 text-green-600">· public</span>
                  )}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
