import { describe, expect, it } from "vitest";
import {
  projectWindow,
  projectMonitorState,
  inspectWindowExecutionState,
  telemetryStableKey,
  projectExecutionProjections,
} from "../src/monitor-projection.js";
import type { WorkspaceOwnerState, WorkspaceTelemetryState } from "@maestro-mobile/shared";

function makeOwner(overrides: Partial<WorkspaceOwnerState> = {}): WorkspaceOwnerState {
  return {
    workspaceId: "ws-1",
    normalizedCwd: "/Users/test/project",
    ownerId: "owner-1",
    pid: 12345,
    sessionId: "sess-12345678-abcd",
    publishedAt: 1789440000000,
    contextPressure: 20,
    agents: [],
    settled: [],
    backgroundJobs: [],
    alive: true,
    ageMs: 500,
    ...overrides,
  };
}

describe("inspectWindowExecutionState & projectWindow", () => {
  it("preserves the producer owner nonce in monitor identity", () => {
    const projected = projectWindow(makeOwner({ ownerNonce: "restart-2" }));
    expect(projected.identity.ownerNonce).toBe("restart-2");
    expect(projected.facets[0]).toMatchObject({ target: { identity: { ownerNonce: "restart-2" } } });
  });

  it("projects only bounded, approved background job fields", () => {
    const projected = projectWindow(makeOwner({
      backgroundJobs: [
        { id: "job-1", status: "running", label: "Build", command: "secret command", token: "do-not-project" },
        { id: "job-2", status: "failed", name: "Test", progress: 2 },
        { status: "running", label: "missing id" },
      ],
    }));
    expect(projected.facets[0]?.data.backgroundJobs).toEqual([
      { id: "job-1", status: "running" },
      { id: "job-2", status: "failed" },
    ]);
    expect(projected.todos).toEqual([]);
  });

  it("does not attach workspace telemetry to an exact session target without an authoritative mapping", () => {
    const projected = projectWindow(makeOwner());
    expect(projected.target).toBeUndefined();
    expect(projected.sessionId).toBe("sess-12345678-abcd");
    expect(projected.identity).not.toHaveProperty("processGeneration");
  });

  it("does not keep an ask after agent_end", () => {
    const projected = projectWindow(makeOwner({
      mainProgress: {
        events: [
          { kind: "lifecycle", phase: "turn_start", at: 1000 },
          { kind: "tool", toolCallId: "ask-1", toolName: "ask_user_question", status: "running", at: 1010 },
          { kind: "lifecycle", phase: "agent_end", at: 1020 },
        ],
      },
    }));
    expect(projected.pendingAsk).toBeUndefined();
    expect(projected.attention).toEqual([]);
  });

  it("marks disconnected window when not alive", () => {
    const owner = makeOwner({ alive: false });
    const projected = projectWindow(owner);
    expect(projected.status).toBe("sleeping");
    expect(projected.lifecycle).toBe("disconnected");
    expect(projected.workStatus).toBe("idle");
  });

  it("marks running when main session has active turn_start", () => {
    const owner = makeOwner({
      alive: true,
      mainProgress: {
        events: [
          { kind: "lifecycle", phase: "turn_start", at: 1000 },
          { kind: "assistant", text: "正在思考...", at: 1010 },
        ],
      },
    });
    const projected = projectWindow(owner);
    expect(projected.status).toBe("running");
    expect(projected.lifecycle).toBe("running");
    expect(projected.workStatus).toBe("idle");
  });

  it("marks running when main session has an in-flight tool call", () => {
    const owner = makeOwner({
      alive: true,
      mainProgress: {
        events: [
          { kind: "lifecycle", phase: "turn_start", at: 1000 },
          { kind: "tool", toolCallId: "call-1", toolName: "read", status: "running", at: 1010 },
        ],
      },
    });
    const projected = projectWindow(owner);
    expect(projected.status).toBe("running");
    expect(projected.lifecycle).toBe("running");
  });

  it("marks idle and settled when main session has reached agent_settled (reproducing e56b18/048d56)", () => {
    const owner = makeOwner({
      ownerId: "e56b18ca3f9b5c493c6bbeab986f63fc",
      alive: true,
      mainActivityAt: 1789440731681,
      mainLastSettle: {
        at: 1789440731681,
        lastResult: "全部修改已确认完毕。",
      },
      mainProgress: {
        events: [
          { kind: "assistant", text: "最终回复内容", at: 1789440731635 },
          { kind: "lifecycle", phase: "turn_end", at: 1789440731639 },
          { kind: "lifecycle", phase: "agent_end", at: 1789440731641 },
          { kind: "lifecycle", phase: "agent_settled", at: 1789440731681 },
        ],
      },
    });
    const projected = projectWindow(owner);
    expect(projected.status).toBe("idle");
    expect(projected.lifecycle).toBe("settled");
    expect(projected.workStatus).toBe("idle");
  });

  it("does not misclassify window as running due to daemon backgroundJobs when main session is settled", () => {
    const owner = makeOwner({
      ownerId: "048d56f2db578637a0acf9eb225064e4",
      alive: true,
      backgroundJobs: [
        {
          id: "bg-host-cli",
          command: "node apps/host/dist/cli.js --port 4739",
          status: "running",
        },
      ],
      mainLastSettle: { at: 1789443326178 },
      mainProgress: {
        events: [
          { kind: "assistant", text: "服务已拉起并校验完毕", at: 1789443326110 },
          { kind: "lifecycle", phase: "turn_end", at: 1789443326114 },
          { kind: "lifecycle", phase: "agent_end", at: 1789443326117 },
          { kind: "lifecycle", phase: "agent_settled", at: 1789443326178 },
        ],
      },
    });
    const projected = projectWindow(owner);
    expect(projected.status).toBe("idle");
    expect(projected.lifecycle).toBe("settled");
  });

  it("marks running and active when sub-agents are running", () => {
    const owner = makeOwner({
      alive: true,
      agents: [
        {
          correlationId: "agent-1",
          agent: "general-executor",
          status: "running",
        },
      ],
      mainProgress: {
        events: [
          { kind: "lifecycle", phase: "agent_settled", at: 1000 },
        ],
      },
    });
    const projected = projectWindow(owner);
    expect(projected.status).toBe("running");
    expect(projected.lifecycle).toBe("running");
    expect(projected.workStatus).toBe("active");
  });

  it("generates stable change key correctly", () => {
    const owner = makeOwner({
      alive: true,
      mainProgress: {
        events: [{ kind: "lifecycle", phase: "agent_settled", at: 1000 }],
      },
    });
    const telemetry: WorkspaceTelemetryState = {
      owners: [owner],
      observedAt: "2026-09-15T00:00:00.000Z",
      aliveCount: 1,
    };
    const key1 = telemetryStableKey(telemetry);
    // observedAt 改变不影响 stable key
    const key2 = telemetryStableKey({ ...telemetry, observedAt: "2026-09-15T00:01:00.000Z" });
    expect(key1).toBe(key2);

    // owner heartbeat 时间变化不影响 stable key
    const heartbeatKey = telemetryStableKey({ ...telemetry, owners: [{ ...owner, publishedAt: owner.publishedAt + 1000, ageMs: 1500 }] });
    expect(heartbeatKey).toBe(key1);

    // 状态从 settled 变为 turn_start 必改变 stable key
    const runningOwner = makeOwner({
      alive: true,
      mainProgress: {
        events: [{ kind: "lifecycle", phase: "turn_start", at: 2000 }],
      },
    });
    const key3 = telemetryStableKey({ ...telemetry, owners: [runningOwner] });
    expect(key3).not.toBe(key1);
  });

  it("emits independent owner projections and one workspace snapshot per workspace", () => {
    const telemetry: WorkspaceTelemetryState = {
      owners: [
        makeOwner({ workspaceId: "ws-1", ownerId: "owner-1", ownerNonce: "nonce-1" }),
        makeOwner({ workspaceId: "ws-2", ownerId: "owner-2", ownerNonce: "nonce-2", sessionId: "sess-2" }),
        makeOwner({ workspaceId: "ws-1", ownerId: "legacy", ownerNonce: undefined, sessionId: "legacy" }),
      ],
      observedAt: "2026-09-15T00:00:00.000Z",
      aliveCount: 3,
    };
    const projections = projectExecutionProjections(telemetry, "host-epoch", 7);
    expect(projections.filter((projection) => projection.scope === "owner")).toHaveLength(6);
    expect(projections.filter((projection) => projection.scope === "workspace").map((projection) => projection.target.workspaceId)).toEqual(["ws-1", "ws-2"]);
    expect(projections.every((projection) => projection.revision === 7 && projection.snapshot)).toBe(true);
  });
  it("classifies #control as monitor_tab and regular owners as session_list", () => {
    const control = projectWindow(makeOwner({ workspaceRole: "monitor", sessionName: "work-session" }));
    const regular = projectWindow(makeOwner({ sessionName: "#control-abc123" }));
    const unknown = projectWindow(makeOwner());
    expect(control.presentation).toMatchObject({ role: "monitor", visibility: "monitor_tab" });
    expect(control.presentation?.control.canAbort).toBe(false);
    expect(regular.presentation).toMatchObject({ role: "session", visibility: "session_list" });
    expect(unknown.presentation).toMatchObject({ role: "session", visibility: "session_list" });
  });
});
