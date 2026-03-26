import { useState, useRef } from "react";
import { clsx } from "clsx";
import type { AIQueryResponse } from "@copilot/shared";
import { useAIQuery } from "../../hooks/useAIQuery.js";
import { useUIStore } from "../../stores/ui.js";

interface CopilotInputProps {
  onResult: (result: AIQueryResponse) => void;
}

const PLACEHOLDER_QUESTIONS = [
  "How many users completed onboarding last week?",
  "Show me DAU for the past 30 days",
  "Which features are most used by Pro plan users?",
  "What's the funnel from trial_started to subscription_created?",
  "Break down signups by country this month",
];

export function CopilotInput({ onResult }: CopilotInputProps) {
  const [question, setQuestion] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeProjectId = useUIStore((s) => s.activeProjectId);
  const timeRange = useUIStore((s) => s.globalTimeRange);

  const { mutate, isPending } = useAIQuery({
    onSuccess: (result) => {
      onResult(result);
    },
  });

  const placeholder = PLACEHOLDER_QUESTIONS[Math.floor(Date.now() / 30000) % PLACEHOLDER_QUESTIONS.length]!;

  function handleSubmit() {
    if (!question.trim() || !activeProjectId || isPending) return;
    mutate({ question: question.trim(), projectId: activeProjectId, timeRange });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="glass-panel p-4">
      <div className="flex items-start gap-3">
        <div className="mt-2 w-6 h-6 rounded-md bg-blue-600/20 flex items-center justify-center shrink-0">
          <svg className="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
          </svg>
        </div>

        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={2}
            className={clsx(
              "w-full bg-transparent text-sm text-gray-100 placeholder-gray-500",
              "resize-none focus:outline-none leading-relaxed"
            )}
            disabled={isPending}
          />

          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-gray-600">
              {!activeProjectId
                ? "Select a project to start"
                : "Press ⌘ Enter to run"}
            </p>

            <button
              onClick={handleSubmit}
              disabled={!question.trim() || !activeProjectId || isPending}
              className={clsx(
                "btn-primary h-8 text-xs",
                "disabled:opacity-40 disabled:cursor-not-allowed"
              )}
            >
              {isPending ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Thinking…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Ask
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
