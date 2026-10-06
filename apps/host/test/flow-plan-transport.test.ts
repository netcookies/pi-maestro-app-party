import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPlanRequest, DesktopPlanResponse } from "@maestro-mobile/shared";
import {
  createDesktopPlanTransport,
  desktopRequestFromFlow,
  type FlowPlanTransportRequest,
} from "../src/plugin/flow-plan-transport.js";

function flowRequest(signal: AbortSignal, overrides: Partial<FlowPlanTransportRequest> = {}): FlowPlanTransportRequest {
  return {
    kind: "confirm",
    sessionId: "session-1",
    operationId: 7,
    cwd: "/work/app",
    mode: "plan",
    sessionFile: "/sessions/session-1.jsonl",
    markdown: "# Plan\n\n- keep",
    revision: 3,
    pathLabel: "plans/current.md",
    availableActions: ["execute", "modify", "discuss"],
    defaultExecution: { backend: "standalone", context: "current" },
    workflow: { allowNew: true },
    modelTransition: { current: "gpt-5" },
    decisionDocuments: ["docs/decision.md"],
    drafts: [{ revision: 2, archivedAt: "2026-09-24T00:00:00Z", checksum: "sha256:old" }],
    signal,
    ...overrides,
  };
}

function clientFor(
  sendPlanRequest: (request: DesktopPlanRequest) => Promise<void> = async () => undefined,
  sendPlanCancellation: (request: DesktopPlanRequest) => Promise<void> = async () => undefined,
) {
  const sent: DesktopPlanRequest[] = [];
  const cancelled: DesktopPlanRequest[] = [];
  return {
    sent,
    cancelled,
    client: {
      sendPlanRequest: async (request: DesktopPlanRequest) => {
        sent.push(request);
        await sendPlanRequest(request);
      },
      sendPlanCancellation: async (request: DesktopPlanRequest) => {
        cancelled.push(request);
        await sendPlanCancellation(request);
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Desktop Flow Plan transport", () => {
  it("maps the complete Flow request and resolves a decision", async () => {
    const { client, sent } = clientFor();
    const transport = createDesktopPlanTransport({ getClient: () => client, isCurrent: () => true });
    const handle = transport.open(flowRequest(new AbortController().signal));
    expect(handle).toBeDefined();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      type: "desktop_plan_request",
      requestId: "plan:session-1:7",
      kind: "confirm",
      sessionId: "session-1",
      operationId: 7,
      cwd: "/work/app",
      mode: "plan",
      markdown: "# Plan\n\n- keep",
      revision: 3,
      availableActions: ["execute", "modify", "discuss"],
      decisionDocuments: ["docs/decision.md"],
      drafts: [{ revision: 2, checksum: "sha256:old" }],
    });
    expect(sent[0]).not.toHaveProperty("deadlineAt");

    const response: DesktopPlanResponse = {
      type: "desktop_plan_response",
      requestId: sent[0].requestId,
      kind: "confirm",
      status: "decision",
      decision: {
        action: "execute",
        execution: { backend: "standalone", context: "current" },
      },
    };
    expect(transport.handleResponse(response)).toBe(true);
    await expect(handle!.promise).resolves.toEqual({
      status: "decision",
      decision: response.decision,
    });
    expect(transport.pendingCount).toBe(0);
  });

  it("preserves edited markdown and expected revision", async () => {
    const { client, sent } = clientFor();
    const transport = createDesktopPlanTransport({ getClient: () => client, isCurrent: () => true });
    const handle = transport.open(flowRequest(new AbortController().signal, { kind: "review" }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(transport.handleResponse({
      type: "desktop_plan_response",
      requestId: sent[0].requestId,
      kind: "review",
      status: "edited",
      markdown: "# Revised",
      expectedRevision: 3,
    })).toBe(true);
    await expect(handle!.promise).resolves.toEqual({
      status: "edited",
      markdown: "# Revised",
      expectedRevision: 3,
    });
  });

  it("rejects target-mismatched/late responses and settles cancellation", async () => {
    const { client, cancelled } = clientFor();
    const transport = createDesktopPlanTransport({ getClient: () => client, isCurrent: () => false });
    expect(transport.open(flowRequest(new AbortController().signal))).toBeUndefined();

    const active = createDesktopPlanTransport({ getClient: () => client, isCurrent: () => true });
    const handle = active.open(flowRequest(new AbortController().signal));
    await vi.waitFor(() => expect(active.pendingCount).toBe(1));
    const request = desktopRequestFromFlow(flowRequest(new AbortController().signal));
    expect(active.handleResponse({
      type: "desktop_plan_response",
      requestId: request.requestId,
      kind: "review",
      status: "cancelled",
    })).toBe(false);
    await handle!.cancel("tui_answered");
    await expect(handle!.promise).resolves.toEqual({ status: "cancelled" });
    expect(cancelled).toHaveLength(1);
    expect(active.handleResponse({
      type: "desktop_plan_response",
      requestId: cancelled[0].requestId,
      kind: cancelled[0].kind,
      status: "decision",
      decision: { action: "execute" },
    })).toBe(false);
  });

  it("replays a live request after reconnect and cancelAll resolves every pending handle", async () => {
    const first = clientFor(async () => { throw new Error("disconnected"); });
    const second = clientFor();
    let current = first.client;
    const transport = createDesktopPlanTransport({ getClient: () => current, isCurrent: () => true });
    const firstHandle = transport.open(flowRequest(new AbortController().signal, { operationId: 8 }));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    expect(transport.pendingCount).toBe(1);
    current = second.client;
    await transport.resendPending();
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0].requestId).toBe(first.sent[0].requestId);

    const secondHandle = transport.open(flowRequest(new AbortController().signal, { operationId: 9 }));
    await vi.waitFor(() => expect(second.sent).toHaveLength(2));
    transport.cancelAll();
    await expect(firstHandle!.promise).resolves.toEqual({ status: "cancelled" });
    await expect(secondHandle!.promise).resolves.toEqual({ status: "cancelled" });
    expect(transport.pendingCount).toBe(0);
  });

  it("registers a Plan while disconnected and replays its identity on reconnect", async () => {
    let current: ReturnType<typeof clientFor>["client"] | undefined;
    const transport = createDesktopPlanTransport({ getClient: () => current, isCurrent: () => true });
    const handle = transport.open(flowRequest(new AbortController().signal, { operationId: 10 }));
    expect(handle).toBeDefined();
    expect(transport.pendingCount).toBe(1);
    const reconnected = clientFor();
    current = reconnected.client;
    await transport.resendPending();
    expect(reconnected.sent).toHaveLength(1);
    expect(reconnected.sent[0].requestId).toBe("plan:session-1:10");
    await handle!.cancel("aborted");
  });

  it("stays pending past the former deadline until explicitly cancelled", async () => {
    vi.useFakeTimers();
    const { client } = clientFor();
    const transport = createDesktopPlanTransport({ getClient: () => client, isCurrent: () => true });
    const handle = transport.open(flowRequest(new AbortController().signal));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.pendingCount).toBe(1);
    let settled = false;
    void handle!.promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await handle!.cancel("aborted");
    await expect(handle!.promise).resolves.toEqual({ status: "cancelled" });
    expect(transport.pendingCount).toBe(0);
  });
});
