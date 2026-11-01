import { describe, expect, it } from "vitest";
import { isHostEvent } from "../src/protocol.js";

function executionEvent(summary: Record<string, unknown>): Record<string, unknown> {
  return {
    seq: 1,
    type: "session_execution_updated",
    summary: {
      target: { sessionId: "s1", endpointId: "ep1", normalizedCwd: "/work", processGeneration: "g1" },
      revision: 1,
      todos: [],
      teammate: { running: 0, total: 0, agents: [] },
      backgroundJobs: [],
      ...summary,
    },
  };
}

describe("SessionExecutionSummary goal projection", () => {
  it("accepts a summary without a goal", () => {
    expect(isHostEvent(executionEvent({}))).toBe(true);
  });

  it("keeps a well-formed goal", () => {
    const event = executionEvent({
      goal: { text: "Ship the release", status: "active", tokenBudget: 100000, tokensUsed: 45000, iteration: 3 },
    });
    expect(isHostEvent(event)).toBe(true);
    expect((event.summary as Record<string, unknown>).goal).toEqual({
      text: "Ship the release", status: "active", tokenBudget: 100000, tokensUsed: 45000, iteration: 3,
    });
  });

  it("drops only the invalid goal field instead of rejecting the whole event", () => {
    const missingStatus = executionEvent({ goal: { text: "Ship the release" } });
    expect(isHostEvent(missingStatus)).toBe(true);
    expect("goal" in (missingStatus.summary as Record<string, unknown>)).toBe(false);

    const badNumber = executionEvent({ goal: { text: "x", status: "active", tokensUsed: "45k" } });
    expect(isHostEvent(badNumber)).toBe(true);
    expect("goal" in (badNumber.summary as Record<string, unknown>)).toBe(false);

    const badAcceptance = executionEvent({ goal: { text: "x", status: "active", acceptance: ["ok", 3] } });
    expect(isHostEvent(badAcceptance)).toBe(true);
    expect("goal" in (badAcceptance.summary as Record<string, unknown>)).toBe(false);
  });

  it("still rejects a summary whose required fields are invalid", () => {
    const event = executionEvent({ goal: { text: "x", status: "active" } });
    (event.summary as Record<string, unknown>).todos = "nope";
    expect(isHostEvent(event)).toBe(false);
  });
});

describe("SessionExecutionSummary loop projection", () => {
  const loop = { id: "loop-1", kind: "prompt", task: "watch CI", status: "scheduled", runCount: 3, maxRuns: 10, intervalMs: 300000 };

  it("keeps a well-formed loop array", () => {
    const event = executionEvent({ loop: [loop] });
    expect(isHostEvent(event)).toBe(true);
    expect((event.summary as Record<string, unknown>).loop).toEqual([loop]);
  });

  it("drops only the invalid loop field", () => {
    const missingRuns = executionEvent({ loop: [{ id: "loop-1", task: "watch", status: "scheduled", maxRuns: 10 }] });
    expect(isHostEvent(missingRuns)).toBe(true);
    expect("loop" in (missingRuns.summary as Record<string, unknown>)).toBe(false);

    const notAnArray = executionEvent({ loop: loop });
    expect(isHostEvent(notAnArray)).toBe(true);
    expect("loop" in (notAnArray.summary as Record<string, unknown>)).toBe(false);

    const negative = executionEvent({ loop: [{ ...loop, runCount: -1 }] });
    expect(isHostEvent(negative)).toBe(true);
    expect("loop" in (negative.summary as Record<string, unknown>)).toBe(false);
  });

  it("accepts an empty loop array as a cleared snapshot", () => {
    const event = executionEvent({ loop: [] });
    expect(isHostEvent(event)).toBe(true);
    expect((event.summary as Record<string, unknown>).loop).toEqual([]);
  });
});

describe("MonitorTodoSummary optional extras", () => {
  const todo = { id: "1", subject: "Task", status: "completed", updatedAt: 10, summary: "done", description: "why", completedAt: 10, durationMs: 90000 };

  it("keeps a well-formed Todo extra set", () => {
    const event = executionEvent({ todos: [todo] });
    expect(isHostEvent(event)).toBe(true);
    expect((event.summary as Record<string, unknown>).todos).toEqual([todo]);
  });

  it("drops only the invalid Todo extras", () => {
    const event = executionEvent({ todos: [{ ...todo, summary: 5, description: null, completedAt: "yesterday", durationMs: -1 }] });
    expect(isHostEvent(event)).toBe(true);
    expect((event.summary as Record<string, unknown>).todos).toEqual([
      { id: "1", subject: "Task", status: "completed", updatedAt: 10 },
    ]);
  });
});
