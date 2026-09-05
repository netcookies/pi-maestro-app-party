import { describe, expect, it } from "vitest";
import {
  windowKey,
  isSameLocalDay,
  isWindowSteerable,
  deriveDashboardMetrics,
} from "../src/dashboard-logic.js";
import type { MonitorWindowSummary, MaestroState, MaestroScheduleSummary } from "@maestro-mobile/shared";

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

describe("isWindowSteerable", () => {
  const controllable = new Set(["sess-1", "sess-2"]);
  it("true when endpointId is an open host session", () => {
    expect(isWindowSteerable("sess-1", controllable)).toBe(true);
  });
  it("false for unknown, empty or closed sessions", () => {
    expect(isWindowSteerable("sess-9", controllable)).toBe(false);
    expect(isWindowSteerable("", controllable)).toBe(false);
    expect(isWindowSteerable("sess-1", new Set())).toBe(false);
  });
});

describe("deriveDashboardMetrics", () => {
  const now = new Date(2026, 8, 5, 12, 0); // 本地 2026-09-05 12:00

  it("returns zeroed metrics for empty state", () => {
    const m = deriveDashboardMetrics({ monitor: null, maestro: null, pendingAsks: [] }, now);
    expect(m.totalWindows).toBe(0);
    expect(m.activeWindows).toBe(0);
    expect(m.runsCompletedToday).toBe(0);
    expect(m.teammatesWorking).toBe(0);
    expect(m.waitingCount).toBe(0);
    expect(m.runningWindows).toEqual([]);
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
    expect(m.teammatesTotal).toBe(3);
    expect(m.teammatesWorking).toBe(2);
    expect(m.runningWindows).toHaveLength(1);
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
