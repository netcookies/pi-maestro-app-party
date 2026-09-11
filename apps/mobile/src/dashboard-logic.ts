/**
 * Dashboard 纯逻辑 — 态势总览数据推导（不依赖 React / store，可单测）
 *
 * 数据来源合同：
 * - monitor: store 投影的窗口状态（telemetry owners → MonitorWindowSummary）
 * - maestro: flow-schedule 调度投影（MaestroState）
 * - pendingAsks: extension-ui 队列中待用户处理的 ask 弹窗
 *
 * 注意：Token 用量当前协议无 usage 统计命令/事件（无数据源），
 * 本模块刻意不提供任何 token 推导，UI 显示「--」并注明需要 Host 接入，严禁编造数字。
 */
import type {
  MaestroState,
  MonitorState,
  MonitorAttentionSummary,
  MonitorWindowSummary,
} from "@maestro-mobile/shared";

/** extension-ui 队列中待处理弹窗的最小投影（解耦 DialogEntry 结构） */
export interface PendingAskItem {
  requestId: string;
  sessionId: string;
  method: string;
  title?: string;
  message?: string;
}

/** 「现在运行」窗口行（含 teammate agent 聚合） */
export interface WindowRunningInfo {
  key: string;
  window: MonitorWindowSummary;
  agentsTotal: number;
  agentsRunning: number;
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
  /** 等待处理 = 待处理 ask 弹窗 + monitor 告警 */
  waitingAsk: number;
  waitingAttention: number;
  waitingCount: number;
  runningWindows: WindowRunningInfo[];
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

/** 目标窗口是否可远程 steer：endpointId 非空且在 Host 已打开（可控）会话集合中 */
export function isWindowSteerable(endpointId: string, controllableSessionIds: ReadonlySet<string>): boolean {
  return endpointId.length > 0 && controllableSessionIds.has(endpointId);
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

/** 态势总览指标推导（纯函数；now 可注入便于测试） */
export function deriveDashboardMetrics(input: DashboardInput, now: Date = new Date()): DashboardMetrics {
  const windows = input.monitor?.windows ?? [];
  const schedules = input.maestro?.schedules ?? [];

  const runningWindows: WindowRunningInfo[] = [];
  let teammatesWorking = 0;
  let teammatesTotal = 0;
  const attentionGroups: AttentionGroup[] = [];

  for (const w of windows) {
    const agents = agentsOfWindow(w);
    teammatesTotal += agents.length;
    const agentsRunning = agents.filter((a) => a.status === "running").length;
    teammatesWorking += agentsRunning;
    if (w.status === "running") {
      runningWindows.push({ key: windowKey(w), window: w, agentsTotal: agents.length, agentsRunning });
    }
    if (Array.isArray(w.attention) && w.attention.length > 0) {
      attentionGroups.push({
        key: windowKey(w),
        windowName: w.name ?? "未命名窗口",
        items: w.attention,
      });
    }
  }

  const runsCompletedToday = schedules.filter(
    (s) => s.state === "completed" && isSameLocalDay(new Date(s.updatedAt), now),
  ).length;
  const runsActive = schedules.filter((s) => s.state === "active").length;

  const waitingAsk = input.pendingAsks.length;
  const waitingAttention = attentionGroups.reduce((n, g) => n + g.items.length, 0);

  return {
    totalWindows: windows.length,
    activeWindows: runningWindows.length,
    runsCompletedToday,
    runsActive,
    teammatesWorking,
    teammatesTotal,
    waitingAsk,
    waitingAttention,
    waitingCount: waitingAsk + waitingAttention,
    runningWindows,
    attentionGroups,
  };
}
