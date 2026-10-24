/**
 * Presentational mapping for the session execution panel.
 *
 * Kept free of React and i18n so the tone/active rules can be unit-tested and
 * reused by both the header chips and the detail sheet.
 */
import type { SessionExecutionSummary } from "@maestro-mobile/mobile-sdk/protocol";

export type ExecutionSectionKey = "todo" | "teammate" | "background";
export type ExecutionTone = "success" | "warning" | "error" | "muted";

export const EXECUTION_SECTION_ORDER: readonly ExecutionSectionKey[] = ["todo", "teammate", "background"];

const TODO_TONES: Record<string, ExecutionTone> = {
  completed: "success",
  done: "success",
  in_progress: "warning",
  running: "warning",
  active: "warning",
  blocked: "error",
  failed: "error",
  pending: "muted",
};

const TEAMMATE_TONES: Record<string, ExecutionTone> = {
  running: "warning",
  retrying: "warning",
  completed: "success",
  failed: "error",
  terminated: "error",
  sleeping: "muted",
  pending: "muted",
};

const BACKGROUND_TONES: Record<string, ExecutionTone> = {
  running: "warning",
  queued: "warning",
  completed: "success",
  failed: "error",
  cancelled: "error",
  unknown: "muted",
};

function toneFrom(table: Record<string, ExecutionTone>, status: string | undefined): ExecutionTone {
  if (!status) return "muted";
  return table[status.toLowerCase()] ?? "muted";
}

export function executionTone(section: ExecutionSectionKey, status: string | undefined): ExecutionTone {
  if (section === "todo") return toneFrom(TODO_TONES, status);
  if (section === "teammate") return toneFrom(TEAMMATE_TONES, status);
  return toneFrom(BACKGROUND_TONES, status);
}

/** Counts shown on the header chips; `active` drives the live pulse dot. */
export interface ExecutionSectionCount {
  readonly active: number;
  readonly done: number;
  readonly total: number;
}

export function executionSectionCounts(
  summary: SessionExecutionSummary,
): Record<ExecutionSectionKey, ExecutionSectionCount> {
  const todoStatuses = summary.todos.map((item) => item.status);
  const agentStatuses = summary.teammate.agents.map((item) => item.status ?? "");
  const jobStatuses = summary.backgroundJobs.map((item) => item.status);

  return {
    todo: {
      active: todoStatuses.filter((status) => executionTone("todo", status) === "warning").length,
      done: todoStatuses.filter((status) => executionTone("todo", status) === "success").length,
      total: todoStatuses.length,
    },
    teammate: {
      active: summary.teammate.running,
      done: agentStatuses.filter((status) => executionTone("teammate", status) === "success").length,
      total: summary.teammate.total || agentStatuses.length,
    },
    background: {
      active: jobStatuses.filter((status) => executionTone("background", status) === "warning").length,
      done: jobStatuses.filter((status) => executionTone("background", status) === "success").length,
      total: jobStatuses.length,
    },
  };
}

/** True when any section still has live work, so the chips can pulse. */
export function hasActiveExecution(counts: Record<ExecutionSectionKey, ExecutionSectionCount>): boolean {
  return EXECUTION_SECTION_ORDER.some((key) => counts[key].active > 0);
}
