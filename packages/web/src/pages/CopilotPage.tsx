import { useState } from "react";
import type { AIQueryResponse } from "@copilot/shared";
import { CopilotInput } from "../components/query/CopilotInput.js";
import { QueryResult } from "../components/query/QueryResult.js";
import { useUIStore } from "../stores/ui.js";
import { formatTimeRange } from "@copilot/shared";

interface ConversationTurn {
  id: string;
  question: string;
  result: AIQueryResponse;
  timestamp: Date;
}

export function CopilotPage() {
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const activeProjectId = useUIStore((s) => s.activeProjectId);
  const timeRange = useUIStore((s) => s.globalTimeRange);
  const setTimeRange = useUIStore((s) => s.setGlobalTimeRange);

  function handleResult(result: AIQueryResponse, question?: string) {
    setHistory((prev) => [
      {
        id: result.queryId,
        question: question ?? "Query",
        result,
        timestamp: new Date(),
      },
      ...prev,
    ]);
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">AI Copilot</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Ask questions about your users in natural language
          </p>
        </div>

        <select
          className="input w-auto text-xs py-1.5"
          value={timeRange}
          onChange={(e) => setTimeRange(e.target.value as typeof timeRange)}
        >
          {(["1d", "7d", "30d", "90d", "365d"] as const).map((r) => (
            <option key={r} value={r}>{formatTimeRange(r)}</option>
          ))}
        </select>
      </div>

      {/* Input */}
      <CopilotInputWithTracking onResult={handleResult} />

      {/* History */}
      {history.length === 0 && !activeProjectId && (
        <EmptyState />
      )}

      <div className="space-y-8">
        {history.map((turn) => (
          <div key={turn.id} className="space-y-3">
            <div className="flex items-start gap-2">
              <div className="w-5 h-5 rounded-full bg-gray-700 flex items-center justify-center shrink-0 mt-0.5">
                <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
              </div>
              <p className="text-sm text-gray-200 font-medium pt-0.5">{turn.question}</p>
            </div>
            <QueryResult result={turn.result} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Wrapper to capture the question text before passing to the base component
function CopilotInputWithTracking({
  onResult,
}: {
  onResult: (result: AIQueryResponse, question?: string) => void;
}) {
  const [pendingQuestion, setPendingQuestion] = useState("");

  return (
    <div>
      <div onChange={(e) => {
        const target = e.target as HTMLTextAreaElement;
        if (target.tagName === "TEXTAREA") setPendingQuestion(target.value);
      }}>
        <CopilotInput onResult={(r) => onResult(r, pendingQuestion)} />
      </div>
    </div>
  );
}

function EmptyState() {
  const suggestions = [
    "How many users signed up this week?",
    "Show me DAU for the past 30 days",
    "What's the conversion rate from trial to paid?",
    "Which pages have the most drop-off?",
  ];

  return (
    <div className="text-center py-12">
      <div className="w-12 h-12 mx-auto rounded-xl bg-blue-600/10 flex items-center justify-center mb-4">
        <svg className="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
      </div>
      <h2 className="text-base font-medium text-gray-300 mb-1">Ask anything about your users</h2>
      <p className="text-sm text-gray-600 mb-6">Select a project and type a question in plain English</p>

      <div className="grid grid-cols-2 gap-2 max-w-md mx-auto">
        {suggestions.map((s) => (
          <button
            key={s}
            className="text-left px-3 py-2.5 rounded-lg border border-gray-800 bg-gray-900/40
                       text-xs text-gray-400 hover:text-gray-200 hover:border-gray-700
                       transition-colors duration-150"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
