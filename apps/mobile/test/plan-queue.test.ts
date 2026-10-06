import { describe, expect, it } from "vitest";
import type { DesktopPlanRequest, SessionTargetIdentity } from "@maestro-mobile/shared";
import { createInitialState, reduceEvent } from "../src/app-state";
import { PlanQueue } from "../src/plan-queue";
import { ExtensionUiQueue } from "../src/extension-ui-queue";

const target: SessionTargetIdentity = {
  sessionId: "session-1",
  endpointId: "desktop-1",
  normalizedCwd: "/work/app",
  processGeneration: "generation-1",
};

const otherTarget: SessionTargetIdentity = { ...target, processGeneration: "generation-2" };

function request(overrides: Partial<DesktopPlanRequest> = {}): DesktopPlanRequest {
  return {
    type: "desktop_plan_request",
    requestId: "plan:session-1:3",
    kind: "confirm",
    sessionId: "session-1",
    operationId: 3,
    cwd: "/work/app",
    mode: "plan",
    markdown: "# Plan",
    revision: 4,
    pathLabel: "plans/current.md",
    availableActions: ["execute", "modify"],
    decisionDocuments: [],
    drafts: [],
    ...overrides,
  };
}

describe("PlanQueue", () => {
  it("keeps Plan state independent from ExtensionUiQueue and keys by exact target", () => {
    const queue = new PlanQueue();
    const entry = queue.enqueue("session-1", request(), target);
    expect(queue.pendingPlans).toEqual([entry]);
    expect(queue.get(entry.request.requestId, entry.request.kind, otherTarget)).toBeUndefined();
    expect(queue.dropAny(entry.request.requestId, otherTarget)).toBe(false);
    expect(queue.pendingPlans).toHaveLength(1);
    expect(queue.dropAny(entry.request.requestId, target)).toBe(true);
    expect(queue.pendingPlans).toHaveLength(0);
  });

  it("reopens a response while the authoritative request remains active", () => {
    const queue = new PlanQueue();
    const entry = queue.enqueue("session-1", request(), target);
    queue.answer(entry.request.requestId, entry.request.kind, {
      type: "desktop_plan_response",
      requestId: entry.request.requestId,
      kind: entry.request.kind,
      status: "edited",
      markdown: "# New draft",
      expectedRevision: 4,
    }, target);
    expect(queue.pendingPlans).toHaveLength(0);
    expect(queue.reopen(entry.request.requestId, entry.request.kind, target)).toBe(true);
    expect(queue.pendingPlans[0].editedMarkdown).toBe("# New draft");
  });

  it("preserves a local draft when the server publishes a higher revision", () => {
    const queue = new PlanQueue();
    const first = queue.enqueue("session-1", request(), target);
    queue.answer(first.request.requestId, first.request.kind, {
      type: "desktop_plan_response",
      requestId: first.request.requestId,
      kind: first.request.kind,
      status: "edited",
      markdown: "# Local draft",
      expectedRevision: first.request.revision,
    }, target);
    const newer = queue.enqueue("session-1", request({ revision: 5, markdown: "# Server revision" }), target);
    expect(newer.request.revision).toBe(5);
    expect(newer.editedMarkdown).toBe("# Local draft");
  });

  it("reopens a response after a failed send without changing the draft", () => {
    const queue = new PlanQueue();
    const entry = queue.enqueue("session-1", request(), target);
    queue.answer(entry.request.requestId, entry.request.kind, {
      type: "desktop_plan_response",
      requestId: entry.request.requestId,
      kind: entry.request.kind,
      status: "edited",
      markdown: "# New draft",
      expectedRevision: 4,
    }, target);
    expect(queue.pendingPlans).toHaveLength(0);
    expect(queue.reopen(entry.request.requestId, entry.request.kind, target)).toBe(true);
    expect(queue.pendingPlans[0].request.markdown).toBe("# Plan");
    expect(queue.pendingPlans[0].editedMarkdown).toBe("# New draft");
    expect(queue.pendingPlans[0].request.revision).toBe(4);
  });
});

describe("Plan app state projection", () => {
  it("clears local Plan projection on reconnect reset and restores it from a fresh event", () => {
    const queue = new PlanQueue();
    const dialogQueue = new ExtensionUiQueue();
    const deps = { planQueue: queue, dialogQueue };
    let state = createInitialState();
    state = reduceEvent(state, { type: "desktop_plan_request", sessionId: "session-1", request: request(), target, seq: 1 }, deps);
    expect(state.planRequests).toHaveLength(1);
    state = reduceEvent(state, { type: "extension_ui_request", sessionId: "session-1", request: { id: "ask-1", sessionId: "session-1", method: "input" }, seq: 1 }, deps);
    state = reduceEvent(state, { type: "__connection_reset" }, deps);
    expect(state.planRequests).toHaveLength(0);
    expect(queue.pendingPlans).toHaveLength(0);
    state = reduceEvent(state, {
      type: "desktop_plan_request", sessionId: "session-1", request: request(), target, seq: 1,
    }, deps);
    expect(state.planRequests).toHaveLength(1);
    expect(state.dialogs).toHaveLength(0);
    state = reduceEvent(state, {
      type: "desktop_plan_cleared",
      sessionId: "session-1",
      requestId: request().requestId,
      target: otherTarget,
      seq: 2,
    }, deps);
    expect(state.planRequests).toHaveLength(1);
    state = reduceEvent(state, {
      type: "desktop_plan_cleared",
      sessionId: "session-1",
      requestId: request().requestId,
      target,
      seq: 3,
    }, deps);
    expect(state.planRequests).toHaveLength(0);
  });

  it("clears only the matching Plan kind when request IDs overlap", () => {
    const confirmRequest = request({ kind: "confirm" });
    const reviewRequest = request({ kind: "review" });
    const queue = new PlanQueue();
    const deps = { planQueue: queue };
    let state = createInitialState();
    state = reduceEvent(state, { type: "desktop_plan_request", sessionId: "session-1", request: confirmRequest, target, seq: 1 }, deps);
    state = reduceEvent(state, { type: "desktop_plan_request", sessionId: "session-1", request: reviewRequest, target, seq: 2 }, deps);
    state = reduceEvent(state, {
      type: "desktop_plan_cleared", sessionId: "session-1", requestId: confirmRequest.requestId,
      kind: "confirm", target, seq: 3,
    }, deps);
    expect(state.planRequests).toHaveLength(1);
    expect(state.planRequests[0].request.kind).toBe("review");
  });

  it("keeps support for legacy clear events without a Plan kind", () => {
    const queue = new PlanQueue();
    const deps = { planQueue: queue };
    let state = createInitialState();
    state = reduceEvent(state, { type: "desktop_plan_request", sessionId: "session-1", request: request(), target, seq: 1 }, deps);
    state = reduceEvent(state, {
      type: "desktop_plan_cleared", sessionId: "session-1", requestId: request().requestId, target, seq: 2,
    }, deps);
    expect(state.planRequests).toHaveLength(0);
  });
});
