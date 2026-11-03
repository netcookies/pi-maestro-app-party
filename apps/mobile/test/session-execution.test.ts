import { describe, expect, it } from "vitest";
import type { SessionExecutionSummary } from "@maestro-mobile/mobile-sdk/protocol";
import { executionTodoCounts } from "../src/session-execution";

const base: SessionExecutionSummary = {
  target: { sessionId: "s1", endpointId: "ep1", normalizedCwd: "/work", processGeneration: "g1" },
  revision: 1,
  todos: [],
  teammate: { running: 0, total: 0, agents: [] },
  backgroundJobs: [],
};

describe("executionTodoCounts", () => {
  it("counts the visible list when the producer sends no aggregate", () => {
    expect(executionTodoCounts({
      ...base,
      todos: [
        { id: "1", subject: "a", status: "completed", updatedAt: 1 },
        { id: "2", subject: "b", status: "pending", updatedAt: 2 },
      ],
    })).toEqual({ done: 1, total: 2 });
  });

  it("prefers the producer aggregate so a truncated window cannot report full completion", () => {
    // Real case: 63 Todos (60 done, 1 blocked, 2 pending) truncated to the first
    // 32 completed items used to render as 32/32.
    const summary: SessionExecutionSummary = {
      ...base,
      todos: Array.from({ length: 32 }, (_, index) => ({
        id: String(index),
        subject: `done-${index}`,
        status: "completed",
        updatedAt: index,
      })),
      todoCounts: { done: 60, total: 63 },
    };
    expect(executionTodoCounts(summary)).toEqual({ done: 60, total: 63 });
  });

  it("treats the legacy done status as completed", () => {
    expect(executionTodoCounts({
      ...base,
      todos: [{ id: "1", subject: "a", status: "DONE", updatedAt: 1 }],
    })).toEqual({ done: 1, total: 1 });
  });
});
