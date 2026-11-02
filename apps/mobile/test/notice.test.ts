import { describe, expect, it } from "vitest";
import { isSystemContinuationPrompt } from "../src/notice";

describe("isSystemContinuationPrompt", () => {
  it("identifies goal continuation prompt", () => {
    expect(isSystemContinuationPrompt("Continue the active goal: keep going until the acceptance criteria pass.")).toBe(true);
    expect(isSystemContinuationPrompt("Continue the active goal")).toBe(true);
  });

  it("identifies compaction checkpoint recovery prompt", () => {
    expect(isSystemContinuationPrompt("Continue the interrupted task from the compacted session checkpoint. Do not wait for another user request.\n\n[maestro-recovery-delivery:33168ea1db5ffa423d543ad3]")).toBe(true);
  });

  it("identifies delivery tag even if leading text varies", () => {
    expect(isSystemContinuationPrompt("Something\n[maestro-recovery-delivery:12345678abcdef01]")).toBe(true);
  });

  it("does not false-positive on normal user text", () => {
    expect(isSystemContinuationPrompt("Please continue the work")).toBe(false);
    expect(isSystemContinuationPrompt("I will continue the active goal tomorrow.")).toBe(false);
    expect(isSystemContinuationPrompt("")).toBe(false);
  });
});
