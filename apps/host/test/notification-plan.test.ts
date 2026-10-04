import { describe, expect, it } from "vitest";
import type { HostEvent, SessionTargetIdentity } from "@maestro-mobile/shared";
import { notificationEventFromHostEvent } from "../src/notifications/notification-normalizer.js";

const target: SessionTargetIdentity = { sessionId: "session-1", endpointId: "desktop-1", normalizedCwd: "/work/app", processGeneration: "generation-1" };
const context = { hostInstanceId: "host-1", nextSequence: (() => { let value = 0; return () => ++value; })() };

function plan(kind: "review" | "confirm"): HostEvent {
  return {
    type: "desktop_plan_request",
    sessionId: target.sessionId,
    target,
    seq: 7,
    request: {
      type: "desktop_plan_request",
      requestId: "request-1",
      kind,
      sessionId: target.sessionId,
      operationId: 1,
      cwd: "/work/app",
      mode: "build",
      markdown: "# Plan",
      revision: 1,
      pathLabel: "work/app Plan",
      availableActions: ["confirm"],
      decisionDocuments: [],
      drafts: [],
      deadlineAt: Date.now() + 60_000,
    },
  };
}

describe("Plan notification normalizer", () => {
  it.each([
    ["review", "plan_review_pending"],
    ["confirm", "plan_confirm_pending"],
  ] as const)("maps %s request to %s", (requestKind, notificationKind) => {
    const result = notificationEventFromHostEvent(plan(requestKind), context);
    expect(result).toMatchObject({ kind: notificationKind, dedupeKey: expect.stringContaining("request-1"), priority: "high" });
  });

  it("does not normalize response or cleared frames", () => {
    expect(notificationEventFromHostEvent({ type: "desktop_plan_cleared", sessionId: target.sessionId, requestId: "request-1", kind: "review", target, seq: 8 }, context)).toBeUndefined();
  });
});
