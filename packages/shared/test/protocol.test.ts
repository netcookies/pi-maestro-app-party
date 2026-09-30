import { describe, expect, it } from "vitest";
import {
  isHostEvent,
  isHostFrame,
  isBackgroundJobSummary,
  isSessionTargetIdentity,
  isClientCommand,
  type HostEvent,
  type ClientCommand,
  type MaestroState,
  type ExtensionUiRequest,
} from "../src/protocol.js";

describe("protocol", () => {
  it("validates HostEvent shape", () => {
    const event: HostEvent = { type: "session_updated", session: {} as never, seq: 1 };
    expect(isHostEvent(event)).toBe(true);
  });

  it("validates Plan clear events with and without the additive kind field", () => {
    const target = { sessionId: "s1", endpointId: "e1", normalizedCwd: "/work", processGeneration: "g1" };
    expect(isHostEvent({ type: "desktop_plan_cleared", sessionId: "s1", requestId: "r1", target, seq: 1 })).toBe(true);
    expect(isHostEvent({ type: "desktop_plan_cleared", sessionId: "s1", requestId: "r1", kind: "review", target, seq: 2 })).toBe(true);
    expect(isHostEvent({ type: "desktop_plan_cleared", sessionId: "s1", requestId: "r1", kind: "other", target, seq: 3 })).toBe(false);
  });

  it("validates an exact-target session summary patch event", () => {
    expect(isHostEvent({
      type: "session_summary_updated",
      target: { sessionId: "s1", endpointId: "e1", normalizedCwd: "/work/app", processGeneration: "g1" },
      patch: {
        runtimeStatus: "running",
        activeSince: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:00:01.000Z",
        messageCount: 4,
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: 0.1 },
        context: { tokens: 8, contextWindow: 100, percent: 8 },
      },
      revision: 2,
      seq: 1,
    })).toBe(true);
    expect(isHostEvent({
      type: "session_summary_updated",
      target: { sessionId: "s1", endpointId: "e1", normalizedCwd: "/work/app", processGeneration: "g1" },
      patch: { reset: true, runtimeStatus: "sleeping" }, revision: 3, seq: 2,
    })).toBe(true);
    expect(isHostEvent({
      type: "session_summary_updated",
      target: { sessionId: "s1", endpointId: "e1", normalizedCwd: "/work/app", processGeneration: "g1" },
      patch: { messageCount: -1 }, revision: 2, seq: 1,
    })).toBe(false);
  });

  it("accepts legacy command errors and validates additive structured errors", () => {
    expect(isHostEvent({ type: "command_error", sessionId: "s1", command: "prompt", message: "failed", seq: 1 })).toBe(true);
    const error = {
      code: "bad_response_status_code",
      type: "bad_response_status_code",
      message: "openai_error",
      source: "provider",
      provider: "my-sub2api-opencode",
      httpStatus: 400,
    };
    expect(isHostEvent({ type: "session_error", sessionId: "s1", target: { sessionId: "s1", endpointId: "e1", normalizedCwd: "/work", processGeneration: "g1" }, error, seq: 2 })).toBe(true);
    expect(isHostEvent({ type: "session_error", sessionId: "s1", error: { ...error, httpStatus: 99 }, seq: 2 })).toBe(false);
    expect(isHostEvent({ type: "session_error", sessionId: "s1", target: { sessionId: "other", endpointId: "e1", normalizedCwd: "/work", processGeneration: "g1" }, error, seq: 2 })).toBe(false);
    expect(isHostFrame({ type: "command_result", in_reply_to: "c1", ok: false, status: "failed", revision: 1, error: { code: "provider_error", details: error } })).toBe(true);
  });

  it("requires complete target identity for session execution summaries", () => {
    const summary = {
      target: { sessionId: "s1", endpointId: "e1", normalizedCwd: "/work", processGeneration: "g1" },
      revision: 1,
      todos: [],
      teammate: { running: 1, total: 1, agents: [{ agent: "planner", status: "running" }] },
      workspace: { label: "@main·7c268c" },
      backgroundJobs: [{ id: "bg1", status: "running" }],
    };
    const target = summary.target;
    expect(isSessionTargetIdentity(summary.target)).toBe(true);
    const window = {
      sessionId: target.sessionId,
      endpointId: target.endpointId,
      target,
      runtimeStatus: "running",
      identity: { workspaceId: "ws-1", ownerId: "owner-1", ownerNonce: "nonce-1", endpointId: "owner-endpoint" },
      status: "running",
      lifecycle: "running",
      workStatus: "active",
      todos: [],
      attention: [],
      facets: [],
    };
    expect(isHostEvent({ type: "monitor_state", state: { windows: [window], observedAt: "2026-01-01T00:00:00Z" }, seq: 1 })).toBe(true);
    expect(isHostEvent({ type: "monitor_state", state: { windows: [{ ...window, target: { ...target, processGeneration: undefined } }], observedAt: "2026-01-01T00:00:00Z" }, seq: 1 })).toBe(false);
    expect(isHostEvent({ type: "monitor_state", state: { windows: [{ ...window, endpointId: "different" }], observedAt: "2026-01-01T00:00:00Z" }, seq: 1 })).toBe(false);
    expect(isHostEvent({ type: "session_execution_updated", summary: { ...summary, teammate: { running: 1, total: 1, agents: [{}] } }, seq: 1 })).toBe(false);
    expect(isHostEvent({ type: "session_execution_updated", summary: { ...summary, workspace: {} }, seq: 1 })).toBe(false);
    expect(isBackgroundJobSummary({ id: "bg1", status: "running", progress: 1.1 })).toBe(false);
  });

  it("validates independent execution projection events and rejects malformed owner identity", () => {
    const target = { workspaceId: "ws-1", ownerId: "owner-1", ownerNonce: "nonce-1", endpointId: "sess-1" };
    const todo = {
      schemaVersion: 1,
      source: "todo",
      scope: "owner",
      target,
      epoch: "nonce-1",
      revision: 3,
      observedAt: "2026-01-01T00:00:00.000Z",
      snapshot: true,
      data: { items: [{ id: "todo-1", subject: "Ship", status: "in_progress", updatedAt: 1 }] },
    };
    expect(isHostEvent({ type: "todo_projection_updated", projection: todo, seq: 4 })).toBe(true);
    expect(isHostEvent({ type: "todo_projection_updated", projection: { ...todo, target: { ...target, ownerNonce: "" } }, seq: 4 })).toBe(false);
    expect(isHostEvent({ type: "todo_projection_updated", projection: { ...todo, target: { ...target, ownerNonce: 1 } }, seq: 4 })).toBe(false);
    expect(isHostEvent({ type: "todo_projection_updated", projection: { ...todo, data: { items: [{ id: "todo-1", subject: "Ship", status: "in_progress" }] } }, seq: 4 })).toBe(false);
  });
  it("rejects malformed HostEvent", () => {
    expect(isHostEvent({ type: "session_updated" })).toBe(false);
    expect(isHostEvent({ type: "session_summary_updated", target: {}, patch: {}, revision: 1, seq: 1 })).toBe(false);
    expect(isHostEvent(null)).toBe(false);
    expect(isHostEvent("string")).toBe(false);
  });

  it("validates ClientCommand shape", () => {
    const target = { sessionId: "s1", endpointId: "desktop-1", normalizedCwd: "/work/app", processGeneration: "generation-1" };
    const cmd: ClientCommand = { type: "prompt", sessionId: "s1", target, message: "hi" };
    expect(isClientCommand(cmd)).toBe(true);
  });

  it("preserves and validates the complete target identity on session commands", () => {
    const target = {
      sessionId: "s1",
      endpointId: "desktop-1",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    };
    expect(isClientCommand({ type: "open_session", cwd: "/work/app", sessionFile: "/sessions/s1.jsonl", target })).toBe(true);
    expect(isClientCommand({ type: "close_session", sessionId: "s1" })).toBe(true);
    expect(isClientCommand({ type: "close_session" })).toBe(false);
    expect(isClientCommand({ type: "get_snapshot", sessionId: "s1", target })).toBe(true);
    expect(isClientCommand({ type: "get_snapshot", sessionId: "s1", target: { ...target, processGeneration: undefined } })).toBe(false);
  });

  it("rejects malformed ClientCommand", () => {
    expect(isClientCommand({})).toBe(false);
    expect(isClientCommand(null)).toBe(false);
  });

  it("supports backward-compatible host session pagination fields", () => {
    const command: ClientCommand = {
      type: "list_host_sessions",
      cwd: "/work/app",
      query: "model",
      limit: 25,
      cursor: "opaque",
      sessionIds: ["live-1"],
      latestForCwds: ["/work/running"],
      includeMonitor: true,
    };
    expect(isClientCommand(command)).toBe(true);
    expect(isClientCommand({ type: "list_host_sessions", includeMonitor: "yes" })).toBe(false);
    expect(isClientCommand({ type: "get_monitor_state" })).toBe(true);
  });

  it("builds a valid MaestroState with schedules", () => {
    const state: MaestroState = {
      schedules: [
        {
          scheduleId: "sch-1",
          title: "Test schedule",
          state: "active",
          progress: { completed: 1, total: 2 },
          steps: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      observedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(state.schedules.length).toBe(1);
    expect(state.schedules[0].state).toBe("active");
  });

  it("serializes ExtensionUiRequest without loss", () => {
    const req: ExtensionUiRequest = {
      id: "req-1",
      sessionId: "s1",
      method: "select",
      title: "Pick an option",
      options: ["A", "B"],
    };
    const json = JSON.stringify(req);
    const parsed = JSON.parse(json) as ExtensionUiRequest;
    expect(parsed).toEqual(req);
  });
});
