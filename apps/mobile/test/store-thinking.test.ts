import { describe, expect, it } from "vitest";
import { normalizeThinkingResult } from "../src/store";

describe("thinking command result normalization", () => {
  it("treats an acknowledged command with no result payload as success", () => {
    expect(normalizeThinkingResult(null)).toEqual({ ok: true });
    expect(normalizeThinkingResult(undefined)).toEqual({ ok: true });
  });

  it("preserves an explicit rejected result for the local error channel", () => {
    expect(normalizeThinkingResult({ ok: false, error: "unsupported" })).toEqual({ ok: false, error: "unsupported" });
  });
});
