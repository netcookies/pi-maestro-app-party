import { describe, expect, it } from "vitest";
import type { SessionExecutionSummary } from "@maestro-mobile/mobile-sdk/protocol";
import {
  EXECUTION_SECTION_ORDER,
  availableExecutionSections,
  executionGlyph,
  executionSectionCounts,
  executionTone,
  formatExecutionId,
  formatGoalDuration,
  formatGoalTokens,
  goalBudgetProgress,
  goalChipDetail,
  goalChipLabel,
  goalTone,
  hasActiveExecution,
  isExecutionItemDone,
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

  it("adds the goal section only when a goal is projected", () => {
    expect(availableExecutionSections(sampleSummary)).toEqual(["todo", "teammate", "background"]);
    expect(availableExecutionSections({ ...sampleSummary, goal: { text: "Ship", status: "active" } }))
      .toEqual(["todo", "teammate", "background", "goal"]);
    expect(executionSectionCounts(sampleSummary).goal).toEqual({ active: 0, done: 0, total: 0 });
    expect(executionSectionCounts({ ...sampleSummary, goal: { text: "Ship", status: "active" } }).goal)
      .toEqual({ active: 1, done: 0, total: 1 });
  });

  it("keeps goal work out of the shared active pulse", () => {
    const goalOnly: SessionExecutionSummary = {
      ...sampleSummary,
      todos: [{ id: "1", subject: "x", status: "completed", updatedAt: 1 }],
      teammate: { running: 0, total: 1, agents: [{ status: "completed" }] },
      backgroundJobs: [{ id: "j1", status: "completed" }],
      goal: { text: "Ship", status: "active" },
    };
    expect(hasActiveExecution(executionSectionCounts(goalOnly))).toBe(false);
  });

  it("maps goal status to tones and glyphs", () => {
    expect(goalTone(undefined)).toBe("muted");
    expect(goalTone({ text: "x", status: "active" })).toBe("warning");
    expect(goalTone({ text: "x", status: "paused" })).toBe("warning");
    expect(goalTone({ text: "x", status: "done" })).toBe("success");
    expect(goalTone({ text: "x", status: "abandoned" })).toBe("error");
    expect(executionTone("goal", "paused")).toBe("warning");
    expect(executionGlyph("goal", "paused")).toBe("❙❙");
    expect(executionGlyph("goal", "active")).toBe("◎");
  });

  it("labels the goal chip with budget, iteration, or pause", () => {
    const labels = { title: "Goal", paused: "·paused" };
    expect(goalChipLabel(undefined, labels)).toBe("");
    expect(goalChipLabel({ text: "x", status: "active", tokenBudget: 100000, tokensUsed: 45000 }, labels)).toBe("Goal 45k/100k");
    expect(goalChipLabel({ text: "x", status: "active", iteration: 3 }, labels)).toBe("Goal ⟳3");
    expect(goalChipLabel({ text: "x", status: "paused", tokenBudget: 100000, tokensUsed: 45000 }, labels)).toBe("Goal 45k/100k ·paused");
    expect(goalChipLabel({ text: "x", status: "active" }, labels)).toBe("Goal");
    expect(goalChipDetail({ text: "x", status: "active", iteration: 0 })).toBe("⟳0");
  });

  it("never produces NaN budget progress", () => {
    expect(goalBudgetProgress(undefined)).toBeUndefined();
    expect(goalBudgetProgress({ text: "x", status: "active" })).toBeUndefined();
    expect(goalBudgetProgress({ text: "x", status: "active", tokenBudget: 0, tokensUsed: 10 })).toBeUndefined();
    expect(goalBudgetProgress({ text: "x", status: "active", tokenBudget: 100000, tokensUsed: 45000 })).toBeCloseTo(0.45);
    expect(goalBudgetProgress({ text: "x", status: "active", tokenBudget: 100000, tokensUsed: 250000 })).toBe(1);
    expect(goalBudgetProgress({ text: "x", status: "active", tokenBudget: 100000 })).toBe(0);
  });

  it("formats goal tokens and elapsed time", () => {
    expect(formatGoalTokens(999)).toBe("999");
    expect(formatGoalTokens(1000)).toBe("1k");
    expect(formatGoalTokens(1234)).toBe("1.2k");
    expect(formatGoalTokens(45000)).toBe("45k");
    expect(formatGoalTokens(100000)).toBe("100k");
    expect(formatGoalTokens(undefined)).toBe("0");

    expect(formatGoalDuration(undefined)).toBe("");
    expect(formatGoalDuration(45)).toBe("45s");
    expect(formatGoalDuration(600)).toBe("10m");
    expect(formatGoalDuration(7500)).toBe("2h 5m");
    expect(formatGoalDuration(7200)).toBe("2h");
  });

  it("maps status to TUI-matching glyphs and done state", () => {
    expect(executionGlyph("todo", "completed")).toBe("✓");
    expect(executionGlyph("todo", "done")).toBe("✓");
    expect(executionGlyph("todo", "in_progress")).toBe("■");
    expect(executionGlyph("todo", "blocked")).toBe("!");
    expect(executionGlyph("todo", "pending")).toBe("□");

    expect(isExecutionItemDone("todo", "completed")).toBe(true);
    expect(isExecutionItemDone("todo", "done")).toBe(true);
    expect(isExecutionItemDone("todo", "in_progress")).toBe(false);
    expect(isExecutionItemDone("todo", "pending")).toBe(false);

    expect(executionGlyph("teammate", "completed")).toBe("✓");
    expect(executionGlyph("teammate", "running")).toBe("■");
    expect(executionGlyph("teammate", "retrying")).toBe("↻");
    expect(executionGlyph("teammate", "sleeping")).toBe("◉");
    expect(executionGlyph("teammate", "failed")).toBe("✗");

    expect(executionGlyph("background", "completed")).toBe("✓");
    expect(executionGlyph("background", "running")).toBe("■");
    expect(executionGlyph("background", "cancelled")).toBe("✗");
  });

  it("formats IDs with leading #", () => {
    expect(formatExecutionId("1")).toBe("#1");
    expect(formatExecutionId("#12")).toBe("#12");
    expect(formatExecutionId("abc")).toBe("#abc");
    expect(formatExecutionId("")).toBe("");
    expect(formatExecutionId(undefined)).toBe("");
  });
});
