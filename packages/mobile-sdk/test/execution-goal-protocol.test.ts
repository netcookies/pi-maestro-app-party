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
