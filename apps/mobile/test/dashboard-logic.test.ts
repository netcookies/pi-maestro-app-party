import { describe, expect, it } from "vitest";
import {
  aggregateSessionUsage,
  getActiveUsageTargets,
  selectMissingUsageTargets,
  getCacheHitPercent,
  windowKey,
  isSameLocalDay,
  deriveDashboardMetrics,
  getWindowContextPressure,
} from "../src/dashboard-logic.js";
import type { MonitorWindowSummary, MaestroState, MaestroScheduleSummary, SessionState, SessionUsageSummary } from "@maestro-mobile/shared";

function makeWindow(overrides: Partial<MonitorWindowSummary> = {}): MonitorWindowSummary {
  return {
    identity: { workspaceId: "ws1", ownerId: "o1", ownerNonce: "", endpointId: "sess-1" },
    name: "窗口A",
    objective: "",
    status: "running",
    lifecycle: "running",
    workStatus: "idle",
    todos: [],
    attention: [],
    facets: [],
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<MaestroScheduleSummary> = {}): MaestroScheduleSummary {
  return {
    scheduleId: "sch-1",
    title: "调度一",
    state: "active",
    progress: { completed: 1, total: 3 },
    steps: [],
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
    ...overrides,
  };
}

describe("windowKey", () => {
  it("composes workspace and owner id", () => {
    expect(windowKey(makeWindow())).toBe("ws1-o1");
  });
});

describe("getWindowContextPressure", () => {
  it("extracts context pressure number correctly", () => {
    const w = makeWindow({
      facets: [
        {
          kind: "teammate-agents",
          target: { identity: { workspaceId: "ws", ownerId: "o", ownerNonce: "", endpointId: "e" } },
          revision: "1",
          data: { contextPressure: 60 },
        },
      ],
    });
    expect(getWindowContextPressure(w)).toBe(60);
  });

  it("extracts context pressure object with percent", () => {
    const w = makeWindow({
      facets: [
        {
          kind: "teammate-agents",
          target: { identity: { workspaceId: "ws", ownerId: "o", ownerNonce: "", endpointId: "e" } },
          revision: "1",
          data: { contextPressure: { percent: 42 } },
        },
      ],
    });
    expect(getWindowContextPressure(w)).toBe(42);
  });

  it("returns null when contextPressure is missing or null", () => {
    const w = makeWindow();
    expect(getWindowContextPressure(w)).toBeNull();
  });
});

describe("isSameLocalDay", () => {
  it("matches same calendar day and rejects different days", () => {
    const a = new Date(2026, 8, 5, 23, 59);
    const b = new Date(2026, 8, 5, 0, 1);
    const c = new Date(2026, 8, 6, 0, 1);
    expect(isSameLocalDay(a, b)).toBe(true);
    expect(isSameLocalDay(a, c)).toBe(false);
  });
  it("rejects invalid dates", () => {
    expect(isSameLocalDay(new Date(NaN), new Date())).toBe(false);
    expect(isSameLocalDay(new Date(), new Date("nope"))).toBe(false);
  });
});

describe("usage aggregation helpers", () => {
  it("filters usage targets to visible session-list current exact targets", () => {
    const session = (id: string, visibility: "session_list" | "hidden"): SessionState => ({
      id,
      cwd: "/work",
      title: id,
      runState: "idle",
      messageCount: 0,
      pendingMessageCount: 0,
      updatedAt: "2026-09-05T00:00:00.000Z",
      presentation: {
        role: "session",
        visibility,
        control: { mode: "readonly", canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
        revision: 1,
      },
    });
    expect(getActiveUsageTargets(
      [session("active", "session_list"), session("hidden", "hidden")],
      [["active", JSON.stringify(["active", "desktop", "/work", "g1"])], ["active", JSON.stringify(["active", "history", "/work", "h1"])], ["hidden", JSON.stringify(["hidden", "desktop", "/work", "g2"])], ["missing", "not-json"]],
    )).toEqual([{ sessionId: "active", targetKey: JSON.stringify(["active", "desktop", "/work", "g1"]) }]);
  });
  it("selects only usage targets absent from host push state", () => {
    const targets = [
      { sessionId: "a", targetKey: "a-key" },
      { sessionId: "b", targetKey: "b-key" },
    ];
    const present = new Map([["a-key", usage("a")]]);
    expect(selectMissingUsageTargets(targets, present)).toEqual([{ sessionId: "b", targetKey: "b-key" }]);
  });
  const usage = (sessionId: string, values: Partial<SessionUsageSummary> = {}): SessionUsageSummary => ({
    sessionId,
    entries: 1,
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 5,
    reasoning: 10,
    totalTokens: 165,
    cost: 0.01,
    context: { tokens: 100, contextWindow: 1000, percent: 10 },
    ...values,
  });

  it("sums token, cache and cost fields across active sessions and ignores empty usage", () => {
    const total = aggregateSessionUsage([
      usage("a"),
      usage("b", { input: 200, output: 40, cacheRead: 60, cacheWrite: 10, reasoning: 20, totalTokens: 330, cost: 0.02 }),
      usage("empty", { entries: 0, totalTokens: 9000 }),
    ]);
    expect(total).toMatchObject({
      entries: 2,
      input: 300,
      output: 60,
      cacheRead: 90,
      cacheWrite: 15,
      reasoning: 30,
      totalTokens: 495,
      cost: 0.03,
      context: null,
    });
  });

  it("calculates cache hit percentage with the session-list denominator", () => {
    const base = { sessionId: "s", entries: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, context: null } as const;
    expect(getCacheHitPercent({ ...base, input: 100, cacheRead: 900 })).toBe(90);
    expect(getCacheHitPercent({ ...base })).toBeNull();
  });
  it("returns null when no session has usage entries", () => {
    expect(aggregateSessionUsage([usage("empty", { entries: 0 })])).toBeNull();
    expect(aggregateSessionUsage([])).toBeNull();
  });
});

describe("deriveDashboardMetrics", () => {
  const now = new Date(2026, 8, 5, 12, 0); // 本地 2026-09-05 12:00

  it("excludes pending Ask attention from system warnings and includes Plan in waiting count", () => {
    const monitor = {
      windows: [makeWindow({ attention: [
        { code: "ask_pending", severity: "warning", message: "等待答复" },
        { code: "DISK_LOW", severity: "warning", message: "磁盘空间低" },
      ] })],
      observedAt: now.toISOString(),
    };
    const m = deriveDashboardMetrics({ monitor, maestro: null, pendingAsks: [{ requestId: "a", sessionId: "s", method: "input" }], pendingPlans: 2 }, now);
    expect(m.attentionGroups.flatMap((group) => group.items).map((item) => item.code)).toEqual(["DISK_LOW"]);
    expect(m.waitingAsk).toBe(1);
    expect(m.waitingPlan).toBe(2);
    expect(m.waitingAttention).toBe(1);
    expect(m.waitingCount).toBe(4);
  });

  it("uses exact execution summaries for teammate totals and displays session errors", () => {
    const m = deriveDashboardMetrics({
      monitor: { windows: [makeWindow()], observedAt: now.toISOString() },
      maestro: null,
      pendingAsks: [],
      executionSummaries: [{
        target: { sessionId: "s", endpointId: "e", normalizedCwd: "/work", processGeneration: "g" },
        revision: 1,
        todos: [],
        teammate: { running: 2, total: 3, agents: [] },
        backgroundJobs: [],
      }],
      sessionErrors: [{ key: "target-key", windowName: "构建窗口", code: "provider_error", message: "模型请求失败" }],
    }, now);
    expect(m.teammatesWorking).toBe(2);
    expect(m.teammatesTotal).toBe(3);
    expect(m.attentionGroups).toEqual([{ key: "session-error:target-key", windowName: "构建窗口", items: [{ code: "provider_error", severity: "error", message: "模型请求失败" }] }]);
  });

  it("counts exact execution todos and today's active sessions", () => {
    const session = (updatedAt: string): SessionState => ({
      id: updatedAt,
      cwd: "/work",
      title: "Session",
      runState: "idle",
      messageCount: 1,
      pendingMessageCount: 0,
      updatedAt,
    });
    const m = deriveDashboardMetrics({
      monitor: null,
      maestro: null,
      pendingAsks: [],
      sessions: [session(now.toISOString()), session(new Date(now.getTime() - 86_400_000).toISOString())],
      executionSummaries: [{
        target: { sessionId: "s", endpointId: "e", normalizedCwd: "/work", processGeneration: "g" },
        revision: 1,
        todos: [
          { id: "completed", subject: "Completed", status: "completed", updatedAt: 1 },
          { id: "done", subject: "Done", status: "done", updatedAt: 1 },
          { id: "todo", subject: "Todo", status: "pending", updatedAt: 1 },
        ],
        teammate: { running: 0, total: 0, agents: [] },
        backgroundJobs: [],
      }],
    }, now);
    expect(m.completedTasks).toBe(2);
    expect(m.totalTasks).toBe(3);
    expect(m.activeSessionsToday).toBe(1);
    expect(m.totalSessions).toBe(2);
  });
  it("returns zeroed metrics for empty state", () => {
    const m = deriveDashboardMetrics({ monitor: null, maestro: null, pendingAsks: [] }, now);
    expect(m.totalWindows).toBe(0);
    expect(m.activeWindows).toBe(0);
    expect(m.runsCompletedToday).toBe(0);
    expect(m.teammatesWorking).toBe(0);
    expect(m.waitingCount).toBe(0);
    expect(m.attentionGroups).toEqual([]);
  });


  it("counts running windows and teammate agents from facets", () => {
    const monitor = {
      windows: [
        makeWindow({
          facets: [{ kind: "teammate-agents", revision: "1", data: { agents: [{ status: "running" }, { status: "done" }, { status: "running" }] } }],
        }),
        makeWindow({ status: "sleeping" }),
      ],
      observedAt: now.toISOString(),
    };
    const m = deriveDashboardMetrics({ monitor, maestro: null, pendingAsks: [] }, now);
    expect(m.totalWindows).toBe(2);
    expect(m.activeWindows).toBe(1);
    const sessionTabMetrics = deriveDashboardMetrics({
      monitor,
      maestro: null,
      pendingAsks: [],
      sessionWindowCounts: { active: 4, total: 7 },
    }, now);
    expect(sessionTabMetrics.activeWindows).toBe(4);
    expect(sessionTabMetrics.totalWindows).toBe(7);
    expect(m.teammatesTotal).toBe(3);
    expect(m.teammatesWorking).toBe(2);
  });

  it("groups attention by window and adds to waitingCount", () => {
    const monitor = {
      windows: [
        makeWindow({ attention: [{ code: "C1", severity: "warning", message: "磁盘低" }] }),
        makeWindow({ attention: [{ code: "C2", severity: "error", message: "崩溃" }] }),
      ],
      observedAt: now.toISOString(),
    };
    const m = deriveDashboardMetrics({ monitor, maestro: null, pendingAsks: [] }, now);
    expect(m.attentionGroups).toHaveLength(2);
    expect(m.waitingAsk).toBe(0);
    expect(m.waitingAttention).toBe(2);
    expect(m.waitingCount).toBe(2);
  });

  it("counts pending asks into waitingCount", () => {
    const m = deriveDashboardMetrics(
      { monitor: null, maestro: null, pendingAsks: [{ requestId: "r1", sessionId: "s1", method: "select" }] },
      now,
    );
    expect(m.waitingAsk).toBe(1);
    expect(m.waitingCount).toBe(1);
  });

  it("counts completed runs only from today and active runs regardless", () => {
    const today = new Date(now.getTime() - 3_600_000).toISOString();
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
    const maestro: MaestroState = {
      schedules: [
        makeSchedule({ state: "completed", updatedAt: today }),
        makeSchedule({ scheduleId: "sch-2", state: "completed", updatedAt: yesterday }),
        makeSchedule({ scheduleId: "sch-3", state: "active", updatedAt: yesterday }),
      ],
      observedAt: now.toISOString(),
    };
    const m = deriveDashboardMetrics({ monitor: null, maestro, pendingAsks: [] }, now);
    expect(m.runsCompletedToday).toBe(1);
    expect(m.runsActive).toBe(1);
  });

  it("ignores malformed updatedAt for run counting", () => {
    const maestro: MaestroState = {
      schedules: [makeSchedule({ state: "completed", updatedAt: "not-a-date" })],
      observedAt: now.toISOString(),
    };
    const m = deriveDashboardMetrics({ monitor: null, maestro, pendingAsks: [] }, now);
    expect(m.runsCompletedToday).toBe(0);
  });
});
