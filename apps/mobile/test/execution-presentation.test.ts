import { describe, expect, it } from "vitest";
import type { SessionExecutionSummary } from "@maestro-mobile/mobile-sdk/protocol";
import {
  EXECUTION_SECTION_ORDER,
  executionSectionCounts,
  executionTone,
  hasActiveExecution,
} from "../src/execution-presentation";

const sampleSummary: SessionExecutionSummary = {
  target: { sessionId: "s1", endpointId: "ep1", normalizedCwd: "/work", processGeneration: "g1" },
  revision: 4,
  todos: [
    { id: "1", subject: "Review PR", status: "completed", updatedAt: 1 },
    { id: "2", subject: "Run tests", status: "in_progress", updatedAt: 2 },
    { id: "3", subject: "Deploy", status: "blocked", updatedAt: 3 },
    { id: "4", subject: "Notify", status: "pending", updatedAt: 4 },
  ],
  teammate: {
    running: 2,
    total: 3,
    agents: [
      { correlationId: "a1", name: "survey", status: "running" },
      { correlationId: "a2", name: "analyst", status: "retrying" },
      { correlationId: "a3", name: "tester", status: "completed" },
    ],
  },
  backgroundJobs: [
    { id: "bg-1", label: "npm build", status: "running" },
    { id: "bg-2", label: "cargo check", status: "completed" },
  ],
};

describe("execution-presentation", () => {
  it("maps status to semantic tone colors", () => {
    expect(executionTone("todo", "completed")).toBe("success");
    expect(executionTone("todo", "in_progress")).toBe("warning");
    expect(executionTone("todo", "blocked")).toBe("error");
    expect(executionTone("todo", "pending")).toBe("muted");

    expect(executionTone("teammate", "running")).toBe("warning");
    expect(executionTone("teammate", "completed")).toBe("success");
    expect(executionTone("teammate", "failed")).toBe("error");

    expect(executionTone("background", "running")).toBe("warning");
    expect(executionTone("background", "completed")).toBe("success");
    expect(executionTone("background", "failed")).toBe("error");
  });

  it("calculates active/done/total counts for each section", () => {
    const counts = executionSectionCounts(sampleSummary);
    expect(counts.todo).toEqual({ active: 1, done: 1, total: 4 });
    expect(counts.teammate).toEqual({ active: 2, done: 1, total: 3 });
    expect(counts.background).toEqual({ active: 1, done: 1, total: 2 });
  });

  it("detects live work when any section has active items", () => {
    const counts = executionSectionCounts(sampleSummary);
    expect(hasActiveExecution(counts)).toBe(true);

    const idleSummary: SessionExecutionSummary = {
      ...sampleSummary,
      todos: [{ id: "1", subject: "x", status: "completed", updatedAt: 1 }],
      teammate: { running: 0, total: 1, agents: [{ status: "completed" }] },
      backgroundJobs: [{ id: "j1", status: "completed" }],
    };
    expect(hasActiveExecution(executionSectionCounts(idleSummary))).toBe(false);
  });

  it("preserves stable section order for tabs and chips", () => {
    expect(EXECUTION_SECTION_ORDER).toEqual(["todo", "teammate", "background"]);
  });
});
