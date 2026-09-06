/**
 * Monitor 状态投影 — WorkspaceTelemetry → MonitorState（host/移动端共享的单一投影源）
 *
 * 合同要点：
 *  - outputTail 截断至有界行数/宽度，避免 WS 广播无界数据
 *  - 变更检测使用稳定键（不含 ageMs/observedAt 等时间派生字段）
 */
import type {
  HostEvent,
  MonitorState,
  MonitorWindowSummary,
  TeammateAgentState,
  TeammateAgentsFacet,
  WorkspaceOwnerState,
  WorkspaceTelemetryState,
} from "@maestro-mobile/shared";

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

export function projectWindow(o: WorkspaceOwnerState): MonitorWindowSummary {
  const identity = {
    workspaceId: o.workspaceId,
    ownerId: o.ownerId,
    ownerNonce: "",
    endpointId: o.sessionId,
  };
  const agents = (o.agents ?? []).slice(0, AGENTS_MAX)
    .map(projectAgent)
    .filter((a): a is TeammateAgentState => a !== null);
  const facet: TeammateAgentsFacet = {
    kind: "teammate-agents",
    target: { identity },
    revision: String(o.publishedAt),
    data: {
      agents,
      backgroundJobs: Array.isArray(o.backgroundJobs) ? o.backgroundJobs.slice(0, 8) : [],
      contextPressure: o.contextPressure,
    },
  };
  return {
    identity,
    name: o.normalizedCwd.split("/").filter(Boolean).pop() ?? o.normalizedCwd,
    cwd: o.normalizedCwd,
    status: o.alive ? "running" : "sleeping",
    lifecycle: o.alive ? "running" : "disconnected",
    workStatus: agents.length > 0 ? "active" : "idle",
    todos: [],
    attention: [],
    facets: [facet],
  };
}

export function projectMonitorState(t: WorkspaceTelemetryState): MonitorState {
  return {
    windows: t.owners.map(projectWindow),
    observedAt: t.observedAt,
  };
}

/**
 * 稳定变更键 — 不含 ageMs/observedAt 等时间派生字段，
 * 只有 owner 集合、身份、发布时间、alive 与 agents 内容变化才触发广播。
 */
export function telemetryStableKey(t: WorkspaceTelemetryState): string {
  const parts = t.owners.map((o) => {
    const agents = (o.agents ?? []).slice(0, AGENTS_MAX).map((a) => {
      if (typeof a !== "object" || a === null) return "?";
      const d = a as Record<string, unknown>;
      const last = Array.isArray(d.outputTail) && d.outputTail.length > 0
        ? String(d.outputTail[d.outputTail.length - 1]).slice(0, OUTPUT_TAIL_MAX_CHARS)
        : "";
      return `${d.correlationId ?? ""}|${d.status ?? ""}|${d.phase ?? ""}|${last}`;
    });
    return `${o.ownerId}|${o.publishedAt}|${o.alive ? 1 : 0}|${agents.join(";;")}`;
  });
  return `${parts.sort().join("||")}`;
}

/** 从 monitor_state 构造 HostEvent（供 controller emit） */
export function monitorStateEvent(state: MonitorState): HostEvent {
  return { type: "monitor_state", state } as HostEvent;
}
