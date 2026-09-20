/**
 * Monitor 状态投影 — WorkspaceTelemetry → MonitorState（host/移动端共享的单一投影源）
 *
 * 合同要点：
 *  - outputTail 截断至有界行数/宽度，避免 WS 广播无界数据
 *  - 变更检测使用稳定键（不含 ageMs/observedAt 等时间派生字段）
 */
import type { HostEvent, MonitorState, MonitorWindowSummary, SessionRuntimeStatus, TeammateAgentState, TeammateAgentsFacet, WorkspaceOwnerState, WorkspaceTelemetryState } from "@maestro-mobile/shared";
import { projectOwnerPresentation } from "./application/session-visibility.js";

/** outputTail 广播上限：每 agent 最多 8 行、每行 200 字符 */
const OUTPUT_TAIL_MAX_LINES = 8;
const OUTPUT_TAIL_MAX_CHARS = 200;

/** agents 投影上限：每 owner 最多 12 个 agent */
const AGENTS_MAX = 12;

function truncateTail(lines: unknown): string[] | undefined {
  if (!Array.isArray(lines)) return undefined;
  const tail = lines
    .slice(-OUTPUT_TAIL_MAX_LINES)
    .map((l) => String(l).slice(0, OUTPUT_TAIL_MAX_CHARS));
  return tail.length > 0 ? tail : undefined;
}

function projectAgent(a: unknown): TeammateAgentState | null {
  if (typeof a !== "object" || a === null) return null;
  const d = a as Record<string, unknown>;
  return {
    correlationId: typeof d.correlationId === "string" ? d.correlationId : undefined,
    name: typeof d.name === "string" ? d.name : undefined,
    agent: typeof d.agent === "string" ? d.agent : undefined,
    status: typeof d.status === "string" ? d.status : undefined,
    phase: typeof d.phase === "string" ? d.phase : undefined,
    outputTail: truncateTail(d.outputTail),
    pendingInteractions: typeof d.pendingInteractions === "number" ? d.pendingInteractions : undefined,
  };
}

interface ProgressEvent {
  kind: string;
  toolName?: string;
  toolCallId?: string;
  status?: string;
  phase?: string;
  text?: string;
}

export interface WindowExecutionState {
  isMainRunning: boolean;
  status: "running" | "idle" | "sleeping";
  lifecycle: "running" | "settled" | "disconnected";
  workStatus: "active" | "idle";
}

/**
 * 精准判定窗口执行状态与生命周期阶段：
 * - 进程存活并不等于窗口正在运行（o.alive 仅代表进程心跳在线与通道连通）；
 * - 结合 mainProgress 事件流、mainLastSettle 时间戳、未决工具调用与子智能体状态，
 *   严格识别主会话是否已经沉降（agent_settled/agent_end/turn_end）。
 */
export function inspectWindowExecutionState(
  o: WorkspaceOwnerState,
  agents: TeammateAgentState[],
  now = Date.now(),
): WindowExecutionState {
  if (!o.alive) {
    return {
      isMainRunning: false,
      status: "sleeping",
      lifecycle: "disconnected",
      workStatus: "idle",
    };
  }

  let isMainRunning = false;

  const progress = o.mainProgress && typeof o.mainProgress === "object"
    ? (o.mainProgress as { events?: ProgressEvent[]; updatedAt?: number })
    : undefined;
  const events = Array.isArray(progress?.events) ? progress.events : [];

  if (events.length > 0) {
    const completedTools = new Set<string>();
    let hasRunningTool = false;
    let latestLifecyclePhase: string | undefined;

    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];

      if (ev.kind === "lifecycle" && ev.phase && !latestLifecyclePhase) {
        latestLifecyclePhase = ev.phase;
      }

      if (ev.kind === "tool" && ev.toolCallId) {
        if (ev.status === "completed" || ev.status === "failed") {
          completedTools.add(ev.toolCallId);
        } else if (ev.status === "running") {
          if (!completedTools.has(ev.toolCallId)) {
            hasRunningTool = true;
          }
        }
      }
    }

    if (latestLifecyclePhase === "agent_settled" || latestLifecyclePhase === "agent_end") {
      // 明确已沉降结束（无论之前是否有未决 tool，agent_settled 代表本轮彻底结束）
      isMainRunning = false;
    } else if (latestLifecyclePhase === "agent_start" || latestLifecyclePhase === "turn_start") {
      // 新轮次正在执行
      isMainRunning = true;
    } else if (hasRunningTool) {
      // 存在未完成的工具调用且尚未 settle
      isMainRunning = true;
    } else if (latestLifecyclePhase === "turn_end") {
      // 一轮结束且无 running tool
      isMainRunning = false;
    }
  } else {
    // events 为空或不存在时，检查 mainLastSettle 与 mainActivityAt
    const settleAt = o.mainLastSettle && typeof o.mainLastSettle === "object" && "at" in o.mainLastSettle
      ? Number((o.mainLastSettle as { at: unknown }).at)
      : 0;
    const mainActAt = typeof o.mainActivityAt === "number" ? o.mainActivityAt : 0;

    if (settleAt > 0 && settleAt >= mainActAt) {
      // 最近一次活动即为 settle，主会话处于已沉降空闲
      isMainRunning = false;
    } else if (mainActAt > 0 && now - mainActAt <= 30_000 && mainActAt > settleAt) {
      // 最近 30 秒内有活动且在上次 settle 之后，主会话正在运行
      isMainRunning = true;
    } else {
      isMainRunning = false;
    }
  }

  const hasRunningAgent = agents.some((a) => a.status === "running");
  const isRunning = isMainRunning || hasRunningAgent;

  return {
    isMainRunning,
    status: isRunning ? "running" : "idle",
    lifecycle: isRunning ? "running" : "settled",
    workStatus: hasRunningAgent ? "active" : "idle",
  };
}

function extractPendingAsk(mainProgress: unknown): { pendingAsk?: MonitorWindowSummary["pendingAsk"]; attentionMessage?: string } {
  if (!mainProgress || typeof mainProgress !== "object") return {};
  const events = (mainProgress as { events?: ProgressEvent[] }).events;
  if (!Array.isArray(events) || events.length === 0) return {};

  const completedToolCallIds = new Set<string>();
  let runningTool: ProgressEvent | undefined;
  let lastAssistantText = "";
  let settled = false;

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === "lifecycle" && (ev.phase === "agent_settled" || ev.phase === "agent_end" || ev.phase === "turn_end")) {
      settled = true;
    }
    if (ev.kind === "lifecycle" && ev.phase === "turn_start") {
      settled = false;
    }

    if (ev.kind === "tool" && ev.toolCallId) {
      if (ev.status === "completed" || ev.status === "failed") {
        completedToolCallIds.add(ev.toolCallId);
      } else if (ev.status === "running") {
        if (!completedToolCallIds.has(ev.toolCallId) && !settled && !runningTool) {
          runningTool = ev;
        }
      }
    }

    if (!lastAssistantText && ev.kind === "assistant" && ev.text) {
      lastAssistantText = ev.text.trim();
    }
  }

  if (runningTool && runningTool.toolName && (runningTool.toolName.includes("ask") || runningTool.toolName.includes("question") || runningTool.toolName.includes("confirm"))) {
    const questionText = lastAssistantText || `正在执行 ${runningTool.toolName}，等待用户交互`;
    return {
      pendingAsk: {
        toolCallId: runningTool.toolCallId ?? "",
        toolName: runningTool.toolName,
        question: questionText,
      },
      attentionMessage: questionText,
    };
  }

  return {};
}

export function projectWindow(o: WorkspaceOwnerState): MonitorWindowSummary {
  const identity = {
    workspaceId: o.workspaceId,
    ownerId: o.ownerId,
    ownerNonce: o.ownerNonce ?? "",
    endpointId: o.sessionId,
  };
  const agents = (o.agents ?? []).slice(0, AGENTS_MAX)
    .map(projectAgent)
    .filter((a): a is TeammateAgentState => a !== null);
  const facet: TeammateAgentsFacet = {
    kind: "teammate-agents",
    target: { identity },
    revision: `${o.ownerId}:${o.ownerNonce ?? ""}:${o.sessionId}`,
    data: {
      agents,
      backgroundJobs: Array.isArray(o.backgroundJobs) ? o.backgroundJobs.slice(0, 8) : [],
      contextPressure: o.contextPressure,
    },
  };
  const { pendingAsk, attentionMessage } = extractPendingAsk(o.mainProgress);
  const attention: MonitorWindowSummary["attention"] = [];
  if (attentionMessage) {
    attention.push({
      code: "ask_pending",
      severity: "warning",
      message: attentionMessage,
    });
  }
  const execState = inspectWindowExecutionState(o, agents);
  const runtimeStatus: SessionRuntimeStatus = execState.status;

  return {
    sessionId: o.sessionId,
    endpointId: o.sessionId,
    runtimeStatus,
    identity,
    name: o.normalizedCwd.split("/").filter(Boolean).pop() ?? o.normalizedCwd,
    cwd: o.normalizedCwd,
    status: execState.status,
    lifecycle: execState.lifecycle,
    workStatus: execState.workStatus,
    todos: [],
    attention,
    facets: [facet],
    ...(pendingAsk ? { pendingAsk } : {}),
    presentation: projectOwnerPresentation(o),
    ...(o.mainLastSettle && typeof o.mainLastSettle === "object" && "at" in o.mainLastSettle ? { lastSettle: o.mainLastSettle as { at: number; lastResult: string } } : {}),
  };
}

export function projectMonitorWindows(t: WorkspaceTelemetryState): MonitorWindowSummary[] {
  return t.owners.map(projectWindow);
}

export function projectMonitorState(t: WorkspaceTelemetryState): MonitorState {
  return {
    windows: projectMonitorWindows(t),
    observedAt: t.observedAt,
  };
}

export function telemetryStableKeyFromWindows(windows: readonly MonitorWindowSummary[]): string {
  const projected = [...windows].sort((a, b) =>
    a.identity.ownerId < b.identity.ownerId ? -1 : a.identity.ownerId > b.identity.ownerId ? 1 : 0,
  );
  return JSON.stringify(projected);
}

/** 稳定变更键不含时间派生字段，保持旧 API 供其他调用方使用。 */
export function telemetryStableKey(t: WorkspaceTelemetryState): string {
  return telemetryStableKeyFromWindows(projectMonitorWindows(t));
}

/** 从 monitor_state 构造 HostEvent（供 controller emit） */
export function monitorStateEvent(state: MonitorState): HostEvent {
  return { type: "monitor_state", state } as HostEvent;
}
