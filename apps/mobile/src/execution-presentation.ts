/**
 * Presentational mapping for the session execution panel.
 *
 * Kept free of React and i18n so the tone/active rules can be unit-tested and
 * reused by both the header chips and the detail sheet.
 */
import type { MonitorTodoSummary, SessionExecutionSummary, SessionGoalSummary, SessionLoopSummary } from "@maestro-mobile/mobile-sdk/protocol";

export type ExecutionSectionKey = "todo" | "teammate" | "background" | "goal" | "loop";
export type ExecutionTone = "success" | "warning" | "error" | "muted";

/** Sections with a generic row model. `goal`/`loop` render their own blocks. */
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

const GOAL_TONES: Record<string, ExecutionTone> = {
  active: "warning",
  running: "warning",
  paused: "warning",
  done: "success",
  completed: "success",
  abandoned: "error",
  failed: "error",
};

const LOOP_TONES: Record<string, ExecutionTone> = {
  scheduled: "warning",
  running: "warning",
  completed: "success",
  failed: "error",
  cancelled: "error",
};

function toneFrom(table: Record<string, ExecutionTone>, status: string | undefined): ExecutionTone {
  if (!status) return "muted";
  return table[status.toLowerCase()] ?? "muted";
}

export function executionTone(section: ExecutionSectionKey, status: string | undefined): ExecutionTone {
  if (section === "todo") return toneFrom(TODO_TONES, status);
  if (section === "teammate") return toneFrom(TEAMMATE_TONES, status);
  if (section === "goal") return toneFrom(GOAL_TONES, status);
  if (section === "loop") return toneFrom(LOOP_TONES, status);
  return toneFrom(BACKGROUND_TONES, status);
}

/** TUI-matching glyph icons for execution status. */
export function executionGlyph(section: ExecutionSectionKey, status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (section === "todo") {
    if (s === "completed" || s === "done") return "✓";
    if (s === "in_progress" || s === "running" || s === "active") return "■";
    if (s === "blocked" || s === "failed") return "!";
    return "□";
  }
  if (section === "teammate") {
    if (s === "completed") return "✓";
    if (s === "running") return "■";
    if (s === "retrying") return "↻";
    if (s === "sleeping") return "◉";
    if (s === "failed" || s === "terminated") return "✗";
    return "□";
  }
  if (section === "goal") return s === "paused" ? "❙❙" : "◎";
  if (section === "loop") {
    if (s === "completed") return "✓";
    if (s === "running") return "■";
    if (s === "scheduled") return "◷";
    if (s === "failed" || s === "cancelled") return "✗";
    return "□";
  }
  if (s === "completed") return "✓";
  if (s === "running") return "■";
  if (s === "failed" || s === "cancelled") return "✗";
  return "□";
}

export function isExecutionItemDone(section: ExecutionSectionKey, status: string | undefined): boolean {
  return executionTone(section, status) === "success";
}

/** Formats numeric or alphanumeric task IDs with a leading # (e.g. "1" -> "#1"). */
export function formatExecutionId(id: string | undefined): string {
  if (!id) return "";
  const trimmed = id.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
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
  const goal = summary.goal;
  const loops = summary.loop ?? [];

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
    goal: {
      active: goal && goalTone(goal) === "warning" && goal.status.toLowerCase() !== "paused" ? 1 : 0,
      done: goal && goalTone(goal) === "success" ? 1 : 0,
      total: goal ? 1 : 0,
    },
    loop: {
      active: loops.filter((item) => executionTone("loop", item.status) === "warning").length,
      done: loops.filter((item) => executionTone("loop", item.status) === "success").length,
      total: loops.length,
    },
  };
}

/** True when any section still has live work, so the chips can pulse. */
export function hasActiveExecution(counts: Record<ExecutionSectionKey, ExecutionSectionCount>): boolean {
  return EXECUTION_SECTION_ORDER.some((key) => counts[key].active > 0);
}

/**
 * Sections to render, in stable order. The Goal section exists only when a live
 * Goal is projected, so Goal-less sessions keep exactly three chips.
 */
export function availableExecutionSections(summary: SessionExecutionSummary): ExecutionSectionKey[] {
  return [
    ...EXECUTION_SECTION_ORDER,
    ...(summary.goal ? ["goal" as const] : []),
    ...(activeLoopCount(summary.loop) > 0 ? ["loop" as const] : []),
  ];
}

/** Loops still being scheduled or running; terminal loops do not keep the chip alive. */
export function activeLoopCount(loops: readonly SessionLoopSummary[] | undefined): number {
  return (loops ?? []).filter((item) => executionTone("loop", item.status) === "warning").length;
}

export function loopTone(loops: readonly SessionLoopSummary[] | undefined): ExecutionTone {
  const list = loops ?? [];
  if (list.length === 0) return "muted";
  if (list.some((item) => executionTone("loop", item.status) === "error")) return "error";
  if (list.some((item) => executionTone("loop", item.status) === "warning")) return "warning";
  return list.every((item) => executionTone("loop", item.status) === "success") ? "success" : "muted";
}

/** Interval milliseconds as a compact duration (`5m` for 300000). */
export function formatLoopInterval(intervalMs: number | undefined): string {
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) return "";
  return formatGoalDuration(Math.round(intervalMs / 1000));
}

/** One bar in the Todo duration strip; `height` is already normalized to px. */
export interface TodoDurationBar {
  readonly id: string;
  readonly durationMs: number;
  readonly height: number;
}

/**
 * Most recently completed Todos with a measured duration, newest first.
 * Heights normalize against the largest selected duration so the strip stays
 * comparable after the detail list expands or collapses.
 */
export function todoDurationBars(
  todos: readonly MonitorTodoSummary[],
  options: { readonly limit?: number; readonly maxHeight?: number } = {},
): TodoDurationBar[] {
  const limit = options.limit ?? 5;
  const maxHeight = options.maxHeight ?? 32;
  const completed = todos
    .map((todo) => ({ todo, durationMs: todo.durationMs ?? 0 }))
    .filter((item) => item.durationMs > 0 && isExecutionItemDone("todo", item.todo.status))
    .sort((a, b) => (b.todo.completedAt ?? b.todo.updatedAt) - (a.todo.completedAt ?? a.todo.updatedAt))
    .slice(0, limit);
  if (completed.length === 0) return [];
  const longest = Math.max(...completed.map((item) => item.durationMs));
  return completed.map((item) => ({
    id: formatExecutionId(item.todo.id),
    durationMs: item.durationMs,
    height: Math.max(2, Math.round((item.durationMs / longest) * maxHeight)),
  }));
}

/**
 * Loop chip label: one loop shows its progress (`Loop ⟳ 3/10`), several show
 * the active count (`Loop ⟳ 2 loops`). Empty when nothing is active.
 */
export function loopChipLabel(
  loops: readonly SessionLoopSummary[] | undefined,
  labels: { readonly title: string; readonly count: string },
): string {
  const list = loops ?? [];
  const active = list.filter((item) => executionTone("loop", item.status) === "warning");
  if (active.length === 0) return "";
  if (active.length === 1) return `${labels.title} ⟳ ${active[0].runCount}/${active[0].maxRuns}`;
  return `${labels.title} ⟳ ${active.length} ${labels.count}`;
}

export function goalTone(goal: SessionGoalSummary | undefined): ExecutionTone {
  if (!goal) return "muted";
  // `active` and `paused` are both unfinished work; the label carries the pause.
  return toneFrom(GOAL_TONES, goal.status);
}

/** 45000 -> "45k", 1234 -> "1.2k", 999 -> "999". */
export function formatGoalTokens(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(Math.round(value));
  const thousands = value / 1000;
  const digits = thousands < 10 ? 1 : 0;
  return `${thousands.toFixed(digits).replace(/\.0$/, "")}k`;
}

/** Elapsed seconds as `45s` / `12m` / `2h 5m`. Empty when not projected. */
export function formatGoalDuration(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest > 0 ? `${Math.floor(minutes / 60)}h ${rest}m` : `${Math.floor(minutes / 60)}h`;
}

/** Budget progress in [0, 1]; undefined when no budget is set (never NaN). */
export function goalBudgetProgress(goal: SessionGoalSummary | undefined): number | undefined {
  if (!goal || typeof goal.tokenBudget !== "number" || !Number.isFinite(goal.tokenBudget) || goal.tokenBudget <= 0) return undefined;
  const used = typeof goal.tokensUsed === "number" && Number.isFinite(goal.tokensUsed) && goal.tokensUsed > 0 ? goal.tokensUsed : 0;
  return Math.min(1, used / goal.tokenBudget);
}

/**
 * Chip caption without the section title, e.g. "45k/100k" or "⟳3".
 * Empty when neither a budget nor an iteration counter is projected.
 */
export function goalChipDetail(goal: SessionGoalSummary | undefined): string {
  if (!goal) return "";
  const budget = goalBudgetProgress(goal);
  if (budget !== undefined) return `${formatGoalTokens(goal.tokensUsed)}/${formatGoalTokens(goal.tokenBudget)}`;
  if (typeof goal.iteration === "number" && Number.isFinite(goal.iteration) && goal.iteration >= 0) return `⟳${goal.iteration}`;
  return "";
}

/** Full chip label: `Goal 45k/100k`, `Goal ⟳3`, paused appends `·暂停`. */
export function goalChipLabel(
  goal: SessionGoalSummary | undefined,
  labels: { readonly title: string; readonly paused: string },
): string {
  if (!goal) return "";
  const detail = goalChipDetail(goal);
  const base = detail ? `${labels.title} ${detail}` : labels.title;
  return goal.status.toLowerCase() === "paused" ? `${base} ${labels.paused}` : base;
}
