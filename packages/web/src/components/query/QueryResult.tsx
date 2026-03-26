import { useState } from "react";
import { clsx } from "clsx";
import type { AIQueryResponse } from "@copilot/shared";
import { formatNumber, formatDuration } from "@copilot/shared";
import { ResultChart } from "../charts/ResultChart.js";

interface QueryResultProps {
  result: AIQueryResponse;
}

export function QueryResult({ result }: QueryResultProps) {
  const [showSQL, setShowSQL] = useState(false);
  const [activeView, setActiveView] = useState<"chart" | "table">("chart");

  if (!result.answerable || !result.result) {
    return (
      <div className="glass-panel p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
            <svg className="w-3 h-3 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
            </svg>
          </div>
          <div>
            <p className="text-sm text-gray-200 font-medium">Can't answer this question</p>
            <p className="text-sm text-gray-400 mt-1">{result.explanation}</p>
          </div>
        </div>
      </div>
    );
  }

  const { result: queryResult, summary, sql, explanation } = result;

  return (
    <div className="space-y-3">
      {/* AI Summary */}
      {summary && (
        <div className="glass-panel p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-5 h-5 rounded-full bg-blue-600/20 flex items-center justify-center shrink-0">
              <svg className="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <p className="text-sm text-gray-200 leading-relaxed">{summary}</p>
          </div>
        </div>
      )}

      {/* Result visualization */}
      <div className="glass-panel overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveView("chart")}
              className={clsx(
                "px-3 py-1 text-xs rounded-md transition-colors",
                activeView === "chart" ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:text-gray-200"
              )}
            >
              Chart
            </button>
            <button
              onClick={() => setActiveView("table")}
              className={clsx(
                "px-3 py-1 text-xs rounded-md transition-colors",
                activeView === "table" ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:text-gray-200"
              )}
            >
              Table
            </button>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">
              {formatNumber(queryResult.rowCount)} rows · {formatDuration(queryResult.executionMs ?? 0)}
              {queryResult.cached && <span className="ml-1 text-green-500">cached</span>}
            </span>
            <button
              onClick={() => setShowSQL(!showSQL)}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              {showSQL ? "Hide SQL" : "View SQL"}
            </button>
          </div>
        </div>

        {/* SQL viewer */}
        {showSQL && sql && (
          <div className="px-4 py-3 bg-gray-950/50 border-b border-gray-800">
            <pre className="text-xs text-blue-300 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
              {sql}
            </pre>
            {explanation && (
              <p className="mt-2 text-xs text-gray-500 italic">{explanation}</p>
            )}
          </div>
        )}

        {/* Chart or table */}
        <div className="p-4">
          {activeView === "chart" ? (
            <ResultChart
              columns={queryResult.columns}
              rows={queryResult.rows}
              chartType={result.suggestedChartType}
            />
          ) : (
            <ResultTable columns={queryResult.columns} rows={queryResult.rows} />
          )}
        </div>

        {queryResult.truncated && (
          <div className="px-4 py-2 bg-amber-500/10 border-t border-amber-500/20">
            <p className="text-xs text-amber-400">
              Results truncated to 10,000 rows. Add a LIMIT clause to your query for smaller result sets.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultTable({ columns, rows }: { columns: Array<{ name: string; type: string }>; rows: Record<string, unknown>[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-800">
            {columns.map((col) => (
              <th key={col.name} className="text-left px-3 py-2 text-gray-400 font-medium whitespace-nowrap">
                {col.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((row, i) => (
            <tr key={i} className={clsx("border-b border-gray-800/50", i % 2 === 0 ? "bg-transparent" : "bg-gray-900/30")}>
              {columns.map((col) => (
                <td key={col.name} className="px-3 py-2 text-gray-300 font-mono whitespace-nowrap">
                  {formatCell(row[col.name], col.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 100 && (
        <p className="text-center py-3 text-xs text-gray-600">
          Showing first 100 of {formatNumber(rows.length)} rows
        </p>
      )}
    </div>
  );
}

function formatCell(value: unknown, type: string): string {
  if (value === null || value === undefined) return "—";
  if (type === "number") return typeof value === "number" ? formatNumber(value) : String(value);
  if (type === "date") return new Date(String(value)).toLocaleDateString();
  return String(value);
}
