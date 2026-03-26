import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/api.js";
import { useUIStore } from "../stores/ui.js";
import type { SavedQuery } from "@copilot/shared";

export function QueryPage() {
  const activeProjectId = useUIStore((s) => s.activeProjectId);

  const { data, isLoading } = useQuery<SavedQuery[]>({
    queryKey: ["saved-queries", activeProjectId],
    queryFn: async () => {
      const res = await apiClient.get<{ data: SavedQuery[] }>(`/v1/queries?projectId=${activeProjectId}`);
      return res.data.data;
    },
    enabled: !!activeProjectId,
  });

  if (!activeProjectId) {
    return (
      <div className="text-center py-20 text-sm text-gray-500">
        Select a project to view saved queries.
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-100">Saved Queries</h1>
        <button className="btn-primary text-xs">New query</button>
      </div>

      {isLoading && (
        <div className="text-center py-12 text-sm text-gray-500">Loading queries…</div>
      )}

      {!isLoading && (!data || data.length === 0) && (
        <div className="text-center py-12 text-sm text-gray-500">
          No saved queries yet. Ask the copilot a question and save the result.
        </div>
      )}

      <div className="space-y-3">
        {data?.map((query) => (
          <div key={query.id} className="glass-panel p-4 flex items-start gap-4 hover:border-gray-700 transition-colors cursor-pointer">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-medium text-gray-100 truncate">{query.title}</h3>
                {query.aiGenerated && (
                  <span className="shrink-0 px-1.5 py-0.5 text-xs rounded bg-blue-600/15 text-blue-400 border border-blue-600/20">
                    AI
                  </span>
                )}
                <span className="shrink-0 px-1.5 py-0.5 text-xs rounded bg-gray-800 text-gray-400">
                  {query.chartType}
                </span>
              </div>
              {query.nlQuestion && (
                <p className="text-xs text-gray-500 truncate mb-1">"{query.nlQuestion}"</p>
              )}
              <code className="text-xs text-gray-600 font-mono truncate block">
                {query.sql.slice(0, 100)}…
              </code>
            </div>
            <div className="text-right shrink-0">
              {query.lastRunMs && (
                <p className="text-xs text-gray-500">{query.lastRunMs}ms</p>
              )}
              {query.lastRunAt && (
                <p className="text-xs text-gray-600">
                  {new Date(query.lastRunAt).toLocaleDateString()}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
