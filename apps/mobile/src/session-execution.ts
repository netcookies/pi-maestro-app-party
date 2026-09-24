import type { SessionExecutionSummary } from "@maestro-mobile/shared";
import type { AppState } from "./app-state";

/** Only exact, complete target keys select session execution data. */
export function selectSessionExecutionSummary(
  summaries: Map<string, SessionExecutionSummary>,
  exactTargetKey: string | undefined,
): SessionExecutionSummary | undefined {
  if (!exactTargetKey) return undefined;
  const summary = summaries.get(exactTargetKey);
  return summary && summary.target ? summary : undefined;
}

export function selectExecutionSummaryForSession(state: AppState, exactTargetKey?: string) {
  return selectSessionExecutionSummary(state.sessionExecutionSummaries, exactTargetKey);
}

export function executionTodoCounts(summary: SessionExecutionSummary) {
  const done = summary.todos.filter((todo) => ["completed", "done"].includes(todo.status.toLowerCase())).length;
  return { done, total: summary.todos.length };
}
