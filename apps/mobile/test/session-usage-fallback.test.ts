import { describe, expect, it } from "vitest";
import { createInitialState, reduceEvent } from "../src/app-state.js";
import { sessionTargetKey } from "@maestro-mobile/shared";

describe("session usage fallback projection", () => {
  it("stores fallback usage only for the current connection generation and exact target", () => {
    const target = { sessionId: "usage", endpointId: "desktop", normalizedCwd: "/work", processGeneration: "g1" };
    const usage = { sessionId: target.sessionId, entries: 1, input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3, cost: 0.1, context: null };
    let state = createInitialState();
    state = reduceEvent(state, { type: "__session_usage_load", target, usage, connectionGeneration: 0 });
    expect(state.hostSessionUsage.get(sessionTargetKey(target))).toEqual(usage);
    state = reduceEvent(state, { type: "__connection_reset", connectionGeneration: 1 });
    const stale = reduceEvent(state, { type: "__session_usage_load", target, usage: { ...usage, totalTokens: 99 }, connectionGeneration: 0 });
    expect(stale.hostSessionUsage.has(sessionTargetKey(target))).toBe(false);
  });
});
