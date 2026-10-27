import { describe, expect, it } from "vitest";
import type { DesktopPluginTarget } from "@maestro-mobile/shared";
import type { SessionTargetIdentity } from "../src/control/SessionDirectory.js";
import {
  actionToFlow,
  applySelection,
  createDesktopRefineTransport,
  snapshotToWire,
  turnToWire,
} from "../src/plugin/flow-refine-transport.js";
import {
  toDesktopRefineAction,
  toDesktopTarget,
} from "../src/plugin/refine-protocol-projection.js";
import {
  toMobileRefineHostEvent,
  toMobileSnapshot,
  toMobileTarget,
  toMobileUpdate,
} from "../src/plugin/refine-wire-to-mobile.js";

const target: DesktopPluginTarget = {
  sessionId: "sess-1",
  endpointId: "ep-1",
  normalizedCwd: "/repo",
  processGeneration: "gen-1",
};

const mobileTarget: SessionTargetIdentity = {
  sessionId: "sess-1",
  endpointId: "ep-1",
  normalizedCwd: "/repo",
  processGeneration: "gen-1",
};

describe("flow refine transport", () => {
  it("declines when refine feature is not supported by the client", () => {
    const transport = createDesktopRefineTransport({
      getClient: () => ({ target, sendPlanRefine: async () => {} }),
      isCurrent: () => true,
      supportsRefine: () => false,
    });
    const handle = transport.open({
      sessionId: "sess-1",
      refineSessionId: "ref-1",
      operationId: 1,
      target,
      cwd: "/repo",
      mode: "plan",
      markdown: "# P",
      revision: 1,
      initialRole: "reviewer",
      signal: new AbortController().signal,
      handleAction: async () => {},
    });
    expect(handle).toBeUndefined();
    expect(transport.pendingCount).toBe(0);
  });

  it("opens, emits snapshot, and sends wire frames when supported", async () => {
    const sent: unknown[] = [];
    const transport = createDesktopRefineTransport({
      getClient: () => ({ target, sendPlanRefine: async (frame) => { sent.push(frame); } }),
      isCurrent: () => true,
      supportsRefine: () => true,
    });
    const handle = transport.open({
      sessionId: "sess-1",
      refineSessionId: "ref-1",
      operationId: 1,
      target,
      cwd: "/repo",
      mode: "plan",
      markdown: "# P",
      revision: 1,
      initialRole: "reviewer",
      signal: new AbortController().signal,
      handleAction: async () => {},
    });
    expect(handle).toBeDefined();
    expect(transport.pendingCount).toBe(1);
    expect(sent).toHaveLength(0);
    handle!.emit({
      type: "snapshot",
      sequence: 1,
      snapshot: {
        refineSessionId: "ref-1", operationId: 1, target, revision: 1, status: "ready", highWaterSequence: 0,
        session: { turns: [], currentRole: "reviewer", currentModel: { model: "provider/initial", label: "Initial model" } },
        turns: [],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "desktop_plan_refine_snapshot",
      refineSessionId: "ref-1",
      sequence: 1,
      status: "ready",
    });

    handle!.emit({
      type: "turn",
      sequence: 2,
      turn: {
        turnId: "t-1",
        role: "reviewer",
        modelLabel: "p/m",
        userInput: "",
        output: "audit",
        createdAt: "2026-10-23T00:00:00.000Z",
        appliesAs: "feedback",
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      type: "desktop_plan_refine_update",
      sequence: 2,
      turn: { output: "audit", role: "reviewer" },
    });
    handle!.emit({ type: "terminal", sequence: 3, status: "discarded" });
    await expect(handle!.promise).resolves.toMatchObject({ action: "discard", terminal: "discarded" });
    expect(transport.pendingCount).toBe(0);
  });

  it("handles selection locally and only delegates resolved run to Flow", async () => {
    let handledAction: unknown;
    const transport = createDesktopRefineTransport({
      getClient: () => ({ target, sendPlanRefine: async () => {} }),
      isCurrent: () => true,
      supportsRefine: () => true,
    });
    transport.open({
      sessionId: "sess-1",
      refineSessionId: "ref-1",
      operationId: 1,
      target,
      cwd: "/repo",
      mode: "plan",
      markdown: "# P",
      revision: 1,
      initialRole: "reviewer",
      signal: new AbortController().signal,
      handleAction: async (action) => { handledAction = action; },
    })!.emit({
      type: "snapshot",
      sequence: 1,
      snapshot: {
        refineSessionId: "ref-1", operationId: 1, target, revision: 1, status: "ready", highWaterSequence: 0,
        session: { turns: [], currentRole: "reviewer", currentModel: { model: "provider/initial", label: "Initial model" } },
        turns: [],
      },
    });

    const base = {
      type: "desktop_plan_refine_action" as const,
      target,
      refineSessionId: "ref-1",
      planRequestId: "ref-1",
      operationId: 1,
      revision: 1,
      actionId: "a-1",
    };

    // Selecting role/model succeeds on the Host without calling Flow.
    expect(await transport.handleAction({ ...base, actionId: "a-role", action: { action: "select_role", role: "optimizer" } })).toBe(true);
    expect(handledAction).toBeUndefined();
    expect(await transport.handleAction({ ...base, actionId: "a-model", action: { action: "select_model", model: "provider/fast" } })).toBe(true);
    expect(handledAction).toBeUndefined();

    // Now run delegates to Flow using the recorded selection.
    expect(await transport.handleAction({ ...base, actionId: "a-run", action: { action: "run", userInput: "tighten" } })).toBe(true);
    expect(handledAction).toMatchObject({
      type: "run",
      actionId: "a-run",
      role: "optimizer",
      model: "provider/fast",
      userInput: "tighten",
    });
  });

  it("resolves the Apply choice without releasing the session before commit terminal", async () => {
    const transport = createDesktopRefineTransport({
      getClient: () => ({ target, sendPlanRefine: async () => {} }),
      isCurrent: () => true,
      supportsRefine: () => true,
    });
    const handle = transport.open({
      sessionId: "sess-1", refineSessionId: "ref-apply", operationId: 7, target,
      cwd: "/repo", mode: "plan", markdown: "# P", revision: 4,
      initialRole: "reviewer", signal: new AbortController().signal,
      handleAction: async () => {},
    })!;
    handle.finish({ action: "apply", turnId: "turn-1" });
    await expect(handle.promise).resolves.toMatchObject({ action: "apply", turnId: "turn-1" });
    expect(transport.pendingCount).toBe(1);
    handle.emit({ type: "terminal", sequence: 1, status: "applied" });
    expect(transport.pendingCount).toBe(0);
  });
  it("returns the first failed action result and rejects content replacement for the same action id", async () => {
    let calls = 0;
    const transport = createDesktopRefineTransport({
      getClient: () => ({ target, sendPlanRefine: async () => {} }),
      isCurrent: () => true,
      supportsRefine: () => true,
    });
    transport.open({
      sessionId: "sess-1", refineSessionId: "ref-fail", operationId: 9, target,
      cwd: "/repo", mode: "plan", markdown: "# P", revision: 1,
      initialRole: "reviewer", signal: new AbortController().signal,
      handleAction: async () => { calls += 1; throw new Error("rejected"); },
    });
    const action = {
      type: "desktop_plan_refine_action" as const,
      target, refineSessionId: "ref-fail", planRequestId: "ref-fail", operationId: 9, revision: 1,
      actionId: "same", action: { action: "run" as const, userInput: "first" },
    };
    await expect(transport.handleAction({ ...action, actionId: "model", action: { action: "select_model", model: "provider/test" } })).resolves.toBe(true);
    await expect(transport.handleAction(action)).resolves.toBe(false);
    await expect(transport.handleAction(action)).resolves.toBe(false);
    expect(calls).toBe(1);
    await expect(transport.handleAction({ ...action, action: { action: "run", userInput: "replacement" } })).resolves.toBe(false);
  });

  it("runs with the session model when the snapshot advertises none", async () => {
    const transport = createDesktopRefineTransport({
      getClient: () => ({ target, sendPlanRefine: async () => {} }),
      isCurrent: () => true,
      supportsRefine: () => true,
      getSessionModel: () => "my-sub2api-gpt/gpt-6.1-sol",
    });
    let handled: unknown;
    const handle = transport.open({
      sessionId: "sess-1", refineSessionId: "ref-session-model", operationId: 21, target,
      cwd: "/repo", mode: "plan", markdown: "# P", revision: 1,
      initialRole: "reviewer", signal: new AbortController().signal,
      handleAction: async (action) => { handled = action; },
    })!;
    // Snapshot without a model: the phone must still be able to run.
    handle.emit({
      type: "snapshot",
      sequence: 1,
      snapshot: {
        refineSessionId: "ref-session-model", operationId: 21, target, revision: 1, status: "ready", highWaterSequence: 0,
        session: { turns: [], currentRole: "reviewer", currentModel: { model: "", label: "Follow current main model" } },
        turns: [],
      },
    });
    const action = {
      type: "desktop_plan_refine_action" as const,
      target, refineSessionId: "ref-session-model", planRequestId: "ref-session-model",
      operationId: 21, revision: 1,
      actionId: "a-run-session-model",
      action: { action: "run" as const, userInput: "" },
    };
    await expect(transport.handleAction(action)).resolves.toBe(true);
    expect(handled).toMatchObject({
      type: "run",
      model: "my-sub2api-gpt/gpt-6.1-sol",
      role: "reviewer",
    });
  });

  it("echoes a model selection back so the phone can render it as selected", async () => {
    const sent: unknown[] = [];
    const transport = createDesktopRefineTransport({
      getClient: () => ({ target, sendPlanRefine: async (frame) => { sent.push(frame); } }),
      isCurrent: () => true,
      supportsRefine: () => true,
    });
    const handle = transport.open({
      sessionId: "sess-1", refineSessionId: "ref-select", operationId: 31, target,
      cwd: "/repo", mode: "plan", markdown: "# P", revision: 2,
      initialRole: "reviewer", signal: new AbortController().signal,
      handleAction: async () => {},
    })!;
    handle.emit({
      type: "snapshot",
      sequence: 1,
      snapshot: {
        refineSessionId: "ref-select", operationId: 31, target, revision: 2, status: "ready", highWaterSequence: 0,
        session: { turns: [], currentRole: "reviewer", currentModel: { model: "p/original", label: "Original" } },
        turns: [],
      },
    });
    await new Promise((r) => setImmediate(r));
    sent.length = 0;
    const ok = await transport.handleAction({
      type: "desktop_plan_refine_action",
      target, refineSessionId: "ref-select", planRequestId: "ref-select",
      operationId: 31, revision: 2, actionId: "a-model-pick",
      action: { action: "select_model", model: "p/picked" },
    });
    expect(ok).toBe(true);
    await new Promise((r) => setImmediate(r));
    const echoed = sent.find((f) => (f as { type?: string }).type === "desktop_plan_refine_snapshot") as
      { currentModel?: string; sequence?: number } | undefined;
    expect(echoed?.currentModel).toBe("p/picked");
    expect(echoed?.sequence).toBe(2);
  });

  it("signal abort drops the mirror and pending entry without settling handle promise as cancel", async () => {
    const transport = createDesktopRefineTransport({
      getClient: () => ({ target, sendPlanRefine: async () => {} }),
      isCurrent: () => true,
      supportsRefine: () => true,
    });
    const controller = new AbortController();
    const handle = transport.open({
      sessionId: "sess-1",
      refineSessionId: "ref-abort",
      operationId: 10,
      target,
      cwd: "/repo",
      mode: "plan",
      markdown: "# P",
      revision: 1,
      initialRole: "reviewer",
      signal: controller.signal,
      handleAction: async () => {},
    })!;
    expect(transport.pendingCount).toBe(1);
    let settled = false;
    void handle.promise.finally(() => { settled = true; });
    controller.abort();
    expect(transport.pendingCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
  });
});

describe("refine protocol projection", () => {
  it("projects exact 4-field Mobile targets to Desktop targets without inference", () => {
    expect(toDesktopTarget(mobileTarget)).toEqual(target);
    expect(toDesktopTarget({ ...mobileTarget, endpointId: "" })).toBeUndefined();
    expect(toMobileTarget(target)).toEqual(mobileTarget);
  });

  it("projects Mobile SDK actions onto Desktop wire frames", () => {
    const sdkAction = {
      type: "plan_refine_action" as const,
      refineSessionId: "ref-1",
      planRequestId: "plan-1",
      operationId: 3,
      revision: 2,
      actionId: "a-9",
      action: { action: "run" as const, userInput: "go" },
    };
    const projected = toDesktopRefineAction(sdkAction, mobileTarget);
    expect(projected).toMatchObject({
      type: "desktop_plan_refine_action",
      target,
      refineSessionId: "ref-1",
      actionId: "a-9",
      action: { action: "run", userInput: "go" },
    });
  });

  it("projects wire snapshots and updates to canonical Mobile HostEvent envelopes", () => {
    const wireSnapshot = {
      type: "desktop_plan_refine_snapshot" as const,
      target,
      refineSessionId: "ref-1",
      planRequestId: "plan-1",
      operationId: 3,
      revision: 2,
      sequence: 1,
      status: "ready" as const,
      markdown: "# P",
      turns: [],
      currentRole: "reviewer" as const,
      currentModel: "m",
      modelOptions: [{ id: "m", name: "Model" }],
      availableActions: ["select_role" as const, "run" as const],
    };
    const event = toMobileRefineHostEvent(target, wireSnapshot);
    expect(event).toMatchObject({
      type: "plan_refine_snapshot",
      sessionId: "sess-1",
      target: mobileTarget,
      snapshot: {
        refineSessionId: "ref-1",
        sequence: 1,
        status: "ready",
      },
    });
  });
});
