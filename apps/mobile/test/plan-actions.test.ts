import { describe, expect, it } from "vitest";
import { normalizePlanAction } from "../src/plan-actions";

describe("normalizePlanAction", () => {
  it.each([
    ["execute", "execute"],
    ["modify", "modify"],
    ["continue", "continue"],
    ["continue_discussion", "continue"],
    ["continue-discussion", "continue"],
    ["discuss", "continue"],
    ["refine", "refine"],
    ["rollback", "rollback"],
    ["exit-plan", "exit-plan"],
    ["exit_plan", "exit-plan"],
    ["close", "close"],
    ["unknown", "unknown"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePlanAction(input)).toBe(expected);
  });
});
