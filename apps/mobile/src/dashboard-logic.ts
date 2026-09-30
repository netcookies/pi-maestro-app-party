/**
 * Dashboard 纯逻辑 — 态势总览数据推导（不依赖 React / store，可单测）
 *
 * 数据来源合同：
 * - monitor: 当前窗口快照；调用方优先使用 Protocol v2 workspace projections
 * - executionSummaries: Desktop Plugin 精确 target 的实时执行摘要
 * - sessionErrors: 当前连接期间收到的会话错误
 * - maestro: flow-schedule 调度投影（MaestroState）
 * - pendingAsks: extension-ui 队列中待用户处理的 ask 弹窗
 *
 * 注意：Token 用量只来自 Host 的 exact-target session usage；无有效 usage 样本时不显示虚构数字。
 */
import type {
  MaestroState,
  MonitorState,
  MonitorAttentionSummary,
  MonitorWindowSummary,
  SessionExecutionSummary,
  SessionState,
  SessionTargetIdentity,
  SessionUsageSummary,
} from "@maestro-mobile/shared";

/** extension-ui 队列中待处理弹窗的最小投影（解耦 DialogEntry 结构） */
export interface PendingAskItem {
  requestId: string;
  sessionId: string;
  target?: SessionTargetIdentity;
  method: string;
  title?: string;
  message?: string;
}

/** 「需要关注」按窗口分组的告警 */
export interface AttentionGroup {
  key: string;
  windowName: string;
  items: MonitorAttentionSummary[];
}

export interface DashboardInput {
  monitor: MonitorState | null;
  maestro: MaestroState | null;
  pendingAsks: PendingAskItem[];
  pendingPlans?: number;
  executionSummaries?: readonly SessionExecutionSummary[];
  sessions?: readonly SessionState[];
  /** 会话 Tab 的 Current / All 数量，优先于 Monitor 窗口投影。 */
  sessionWindowCounts?: { active: number; total: number };
  sessionErrors?: readonly { key: string; windowName: string; code: string; message: string }[];
}

export interface DashboardMetrics {
  totalWindows: number;
  /** 活跃窗口（status === running，即 telemetry heartbeat 新鲜） */
  activeWindows: number;
  /** 今日 Run 完成：updatedAt 在今日（本地时区）且 state=completed 的调度数 */
  runsCompletedToday: number;
  /** 进行中（active）的调度数 */
  runsActive: number;
  /** Teammate 工作中：各窗口 facets.teammate-agents 中 status=running 的 agent 总数 */
  teammatesWorking: number;
  /** 可见的 teammate agent 总数 */
  teammatesTotal: number;
  /** 当前 exact-target session list 中今日有活动的会话数。 */
  activeSessionsToday: number;
  totalSessions: number;
  /** 当前 exact-target execution summaries 中已完成/全部 todo 数；无摘要时为 null。 */
  completedTasks: number | null;
  totalTasks: number | null;
  /** 等待处理 = 待处理 Ask + 待处理 Plan + 系统警告 */
  waitingAsk: number;
  waitingPlan: number;
  waitingAttention: number;
  waitingCount: number;
  attentionGroups: AttentionGroup[];
}

/** Monitor 窗口列表 key（与 monitor.tsx / teammate.tsx 一致） */
export function windowKey(w: MonitorWindowSummary): string {
  return `${w.identity.workspaceId}-${w.identity.ownerId}`;
}

/** 本地时区同一天判断（Invalid Date 恒为 false） */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  );
}

/** 提取窗口 teammate-agents facet 的 agents 数组（结构异常时安全返回空） */
function agentsOfWindow(w: MonitorWindowSummary): Array<{ status?: unknown }> {
  for (const f of w.facets ?? []) {
    if (f && typeof f === "object" && !Array.isArray(f)) {
      const facet = f as unknown as Record<string, unknown>;
      if (facet.kind === "teammate-agents") {
        const data = facet.data as { agents?: unknown } | undefined;
        if (data && Array.isArray(data.agents)) {
          return data.agents.filter((a): a is { status?: unknown } =>
            typeof a === "object" && a !== null) as Array<{ status?: unknown }>;
        }
      }
    }
  }
  return [];
}

/** 提取窗口上下文压力百分比（0-100；无数据返回 null） */
export function getWindowContextPressure(w: MonitorWindowSummary): number | null {
  for (const f of w.facets ?? []) {
    if (f && typeof f === "object" && !Array.isArray(f)) {
      const facet = f as unknown as Record<string, unknown>;
      if (facet.kind === "teammate-agents") {
        const data = facet.data as { contextPressure?: unknown } | undefined;
        if (data && data.contextPressure !== undefined && data.contextPressure !== null) {
          const cp = data.contextPressure;
          if (typeof cp === "number" && Number.isFinite(cp)) {
            return Math.max(0, Math.min(100, Math.round(cp)));
          }
          if (typeof cp === "object" && cp !== null && "percent" in cp) {
            const p = (cp as { percent?: unknown }).percent;
            if (typeof p === "number" && Number.isFinite(p)) {
              return Math.max(0, Math.min(100, Math.round(p)));
            }
          }
        }
      }
    }
  }
  return null;
}

export interface ActiveUsageTarget {
  sessionId: string;
  targetKey: string;
}

/** 返回会话 Tab Current 集合中的非历史 exact target；每个 sessionId 至多一个 target。 */
export function getActiveUsageTargets(
  sessions: readonly SessionState[],
  activeSessionTargets: Iterable<readonly [string, string]>,
): ActiveUsageTarget[] {
  const visibleSessionIds = new Set(
    sessions.filter((session) => session.presentation?.visibility === "session_list").map((session) => session.id),
  );
  return [...activeSessionTargets]
    .filter(([sessionId, targetKey]) => {
      if (!visibleSessionIds.has(sessionId)) return false;
      try {
        const target = JSON.parse(targetKey) as unknown;
        return Array.isArray(target) && target[1] !== "history";
      } catch {
        return false;
      }
    })
    .map(([sessionId, targetKey]) => ({ sessionId, targetKey }));
}

/** 汇总所有 Current exact-target 会话的 usage；没有有效样本时返回 null。 */
export function aggregateSessionUsage(usages: readonly SessionUsageSummary[]): SessionUsageSummary | null {
  const valid = usages.filter((usage) => usage.entries > 0);
  if (valid.length === 0) return null;
  return valid.reduce<SessionUsageSummary>((total, usage) => ({
    sessionId: "active-sessions",
    entries: total.entries + usage.entries,
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    reasoning: total.reasoning + usage.reasoning,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: total.cost + usage.cost,
    context: null,
  }), {
    sessionId: "active-sessions",
    entries: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: 0,
    context: null,
  });
}

/** 汇总缓存命中率：沿用会话列表口径 cacheRead / (input + cacheRead)。 */
export function getCacheHitPercent(usage: SessionUsageSummary): number | null {
  const denominator = usage.input + usage.cacheRead;
  return denominator > 0 ? Math.round((usage.cacheRead / denominator) * 100) : null;
}

/** 态势总览指标推导（纯函数；now 可注入便于测试） */
export function deriveDashboardMetrics(input: DashboardInput, now: Date = new Date()): DashboardMetrics {
  const windows = input.monitor?.windows ?? [];
  const schedules = input.maestro?.schedules ?? [];

  let teammatesWorking = 0;
  let teammatesTotal = 0;
  const attentionGroups: AttentionGroup[] = [];

  for (const w of windows) {
    const agents = agentsOfWindow(w);
    teammatesTotal += agents.length;
    const agentsRunning = agents.filter((a) => a.status === "running").length;
    teammatesWorking += agentsRunning;
    const warnings = Array.isArray(w.attention)
      ? w.attention.filter((item) => item.code !== "ask_pending")
      : [];
    if (warnings.length > 0) {
      attentionGroups.push({
        key: windowKey(w),
        windowName: w.name ?? "未命名窗口",
        items: warnings,
      });
    }
  }

  if (input.executionSummaries) {
    teammatesWorking = input.executionSummaries.reduce((total, summary) => total + summary.teammate.running, 0);
    teammatesTotal = input.executionSummaries.reduce((total, summary) => total + summary.teammate.total, 0);
  }

  for (const error of input.sessionErrors ?? []) {
    attentionGroups.push({
      key: `session-error:${error.key}`,
      windowName: error.windowName,
      items: [{ code: error.code, severity: "error", message: error.message }],
    });
  }

  const runsCompletedToday = schedules.filter(
    (s) => s.state === "completed" && isSameLocalDay(new Date(s.updatedAt), now),
  ).length;
  const runsActive = schedules.filter((s) => s.state === "active").length;
  const sessions = input.sessions ?? [];
  const activeSessionsToday = sessions.filter((session) => isSameLocalDay(new Date(session.updatedAt), now)).length;
  const totalSessions = sessions.length;
  const completedTasks = input.executionSummaries
    ? input.executionSummaries.reduce((total, summary) => total + summary.todos.filter((todo) => ["completed", "done"].includes(todo.status.toLowerCase())).length, 0)
    : null;
  const totalTasks = input.executionSummaries
    ? input.executionSummaries.reduce((total, summary) => total + summary.todos.length, 0)
    : null;

  const waitingAsk = input.pendingAsks.length;
  const waitingPlan = input.pendingPlans ?? 0;
  const waitingAttention = attentionGroups.reduce((n, g) => n + g.items.length, 0);

  return {
    totalWindows: input.sessionWindowCounts?.total ?? windows.length,
    activeWindows: input.sessionWindowCounts?.active ?? windows.filter((w) => w.status === "running").length,
    runsCompletedToday,
    runsActive,
    activeSessionsToday,
    totalSessions,
    completedTasks,
    totalTasks,
    teammatesWorking,
    teammatesTotal,
    waitingAsk,
    waitingPlan,
    waitingAttention,
    waitingCount: waitingAsk + waitingPlan + waitingAttention,
    attentionGroups,
  };
}
