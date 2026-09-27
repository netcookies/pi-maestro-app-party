import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import type { DesktopPlanRequest, DesktopPlanResponse } from "@maestro-mobile/shared";
import type { DesktopPluginTransport } from "../src/plugin/desktop-plugin-registry.js";
import { mkdir, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const HOST_VERSION = (JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

function catalog() { return { listSessions: async () => [] }; }
function transport(request: DesktopPluginTransport["request"] = async (command) => ({
  type: "desktop_plugin_result" as const,
  requestId: command.requestId,
  operation: command.operation.type,
  status: "observed" as const,
})) {
  return { request, close: vi.fn() } satisfies DesktopPluginTransport;
}

function target(sessionId = "desktop-session", endpointId = "desktop-endpoint", processGeneration = "generation-1") {
  return { sessionId, endpointId, normalizedCwd: "/work/app", processGeneration };
}

describe("HostController", () => {
  let tmpDir: string;
  let controller: HostController;
  let reader: MaestroStateReader;
  let events: unknown[];

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `maestro-host-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    reader = new MaestroStateReader({ projectRoot: tmpDir });
    controller = new HostController(catalog(), reader);
    events = [];
    controller.onEvent((event) => events.push(event));
  });

  afterEach(async () => {
    await controller.dispose();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns initial status", () => {
    expect(controller.getStatus()).toMatchObject({ ok: true, version: HOST_VERSION, sessions: 0 });
  });

  it("starts and stops Maestro polling", async () => {
    const scheduleDir = join(tmpDir, ".pi", "flow-schedule", "v1", "schedules");
    await mkdir(scheduleDir, { recursive: true });
    await writeFile(join(scheduleDir, "schedule.json"), JSON.stringify({ scheduleId: "schedule", state: "active", stepIds: [], steps: {}, createdAt: Date.now(), updatedAt: Date.now() }));
    await controller.startMaestroPoll(100);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toContainEqual(expect.objectContaining({ type: "maestro_state" }));
    controller.stopMaestroPoll();
  });

  it("does not expose deleted Host-owned lifecycle methods", () => {
    expect("openSession" in controller).toBe(false);
    expect("closeSession" in controller).toBe(false);
    expect("getSession" in controller).toBe(false);
  });

  it("registers an exact Desktop target and reads its JSONL snapshot without a runner", async () => {
    const sessionFile = join(tmpDir, "desktop.jsonl");
    await writeFile(sessionFile, [
      JSON.stringify({ type: "message", message: { role: "user", content: "hello", timestamp: 1756800000000 } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "world", timestamp: 1756800100000 } }),
    ].join("\n") + "\n");
    const exact = target();
    controller.desktopPlugins.register({ target: exact, sessionFile, capabilities: ["prompt", "abort", "set_thinking"], transport: transport() });
    controller.registerDesktopTarget(exact);

    expect(controller.directory.resolve(exact)).toMatchObject({ kind: "desktop", sessionFile, identity: exact });
    await expect(controller.application.query({ kind: "session_snapshot", target: exact })).resolves.toMatchObject({
      ok: true,
      value: {
        session: { id: exact.sessionId, presentation: { control: { mode: "desktop_plugin", canPrompt: true, canAbort: true } } },
        timeline: [{ text: "hello" }, { text: "world" }],
        historyAvailable: true,
      },
    });
    expect(controller.directory.resolve(exact)).not.toHaveProperty("runner");
  });

  it("routes Desktop commands to the exact target and rejects a sibling generation", async () => {
    const exact = target("same-session", "endpoint-a", "generation-a");
    const sibling = target("same-session", "endpoint-b", "generation-b");
    const request = vi.fn<DesktopPluginTransport["request"]>(async (command) => ({ type: "desktop_plugin_result", requestId: command.requestId, operation: command.operation.type, status: "observed" }));
    controller.desktopPlugins.register({ target: exact, capabilities: ["abort", "set_thinking"], transport: transport(request) });
    controller.desktopPlugins.register({ target: sibling, capabilities: ["abort", "set_thinking"], transport: transport(request) });
    controller.registerDesktopTarget(exact);
    controller.registerDesktopTarget(sibling);

    await expect(controller.application.command({ requestId: "abort", target: exact, kind: "abort" })).resolves.toMatchObject({ status: "observed" });
    await expect(controller.application.command({ requestId: "stale", target: { ...exact, processGeneration: "stale" }, kind: "abort" })).resolves.toMatchObject({ status: "unknown", error: { code: "target_unavailable" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("routes ask responses only to the exact Desktop target", async () => {
    const exact = target("ask-session", "endpoint-a", "generation-a");
    const sibling = target("ask-session", "endpoint-b", "generation-b");
    const answerAsk = vi.fn(async (response: { requestId: string; toolCallId: string }) => ({ type: "desktop_ask_result" as const, requestId: response.requestId, toolCallId: response.toolCallId, status: "accepted" as const }));
    const pluginTransport = { ...transport(), answerAsk };
    controller.desktopPlugins.register({ target: exact, capabilities: ["ask-user-question"], transport: pluginTransport });
    controller.desktopPlugins.register({ target: sibling, capabilities: ["ask-user-question"], transport: transport() });
    controller.registerDesktopTarget(exact);
    controller.registerDesktopTarget(sibling);
    controller.onDesktopAskRequest(exact, { type: "desktop_ask_request", requestId: "ask-1", toolCallId: "tool-1", questions: [{ question: "Continue?" }], deadlineAt: Date.now() + 10_000 });
    const event = events.find((entry) => (entry as { type?: string }).type === "extension_ui_request") as { request: { id: string } };
    expect(event).toBeTruthy();
    await expect(controller.respondToExtensionUi(exact.sessionId, event.request.id, { id: event.request.id, selected: ["yes"] }, sibling)).resolves.toBe(false);
    await expect(controller.respondToExtensionUi(exact.sessionId, event.request.id, { id: event.request.id, selected: ["yes"] }, exact)).resolves.toBe(true);
    expect(answerAsk).toHaveBeenCalledTimes(1);
  });

  it("correlates Plan responses by exact target, request ID, and kind", async () => {
    const exact = target("plan-session", "endpoint-a", "generation-a");
    const answerPlan = vi.fn(async (response: DesktopPlanResponse) => ({
      type: "desktop_plan_result" as const,
      requestId: response.requestId,
      kind: response.kind,
      status: "accepted" as const,
    }));
    const pluginTransport = { ...transport(), answerPlan };
    controller.desktopPlugins.register({ target: exact, capabilities: ["plan"], transport: pluginTransport });
    controller.registerDesktopTarget(exact);
    const makeRequest = (kind: DesktopPlanRequest["kind"], operationId: number): DesktopPlanRequest => ({
      type: "desktop_plan_request",
      requestId: "same-request",
      kind,
      sessionId: exact.sessionId,
      operationId,
      cwd: exact.normalizedCwd,
      mode: "plan",
      markdown: "# Plan",
      revision: 1,
      pathLabel: "plans/current.md",
      availableActions: ["execute"],
      decisionDocuments: [],
      drafts: [],
      deadlineAt: Date.now() + 10_000,
    });
    controller.onDesktopPlanRequest(exact, makeRequest("confirm", 1));
    controller.onDesktopPlanRequest(exact, makeRequest("review", 2));
    await expect(controller.respondToDesktopPlan(exact.sessionId, "same-request", {
      type: "desktop_plan_response", requestId: "same-request", kind: "confirm", status: "cancelled",
    }, exact)).resolves.toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "desktop_plan_cleared", requestId: "same-request", kind: "confirm" }));
    await expect(controller.respondToDesktopPlan(exact.sessionId, "same-request", {
      type: "desktop_plan_response", requestId: "same-request", kind: "review", status: "cancelled",
    }, exact)).resolves.toBe(true);
    expect(answerPlan).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => (event as { type?: string }).type === "desktop_plan_cleared")).toHaveLength(2);
  });

  it("clears pending Plan requests when an exact Desktop target unregisters", async () => {
    const exact = target("plan-unregister", "endpoint-a", "generation-a");
    controller.desktopPlugins.register({ target: exact, capabilities: ["plan"], transport: transport() });
    controller.registerDesktopTarget(exact);
    controller.onDesktopPlanRequest(exact, {
      type: "desktop_plan_request", requestId: "unregister-request", kind: "confirm", sessionId: exact.sessionId,
      operationId: 1, cwd: exact.normalizedCwd, mode: "plan", markdown: "# Plan", revision: 1,
      pathLabel: "plans/current.md", availableActions: ["execute"], decisionDocuments: [], drafts: [], deadlineAt: Date.now() + 10_000,
    });
    controller.desktopPlugins.unregister(exact);
    controller.unregisterDesktopTarget(exact);
    expect(events).toContainEqual(expect.objectContaining({ type: "desktop_plan_cleared", requestId: "unregister-request", kind: "confirm", target: exact }));
  });
  it("streams appended JSONL items independently for sibling Desktop targets", async () => {
    const sessionFile = join(tmpDir, "live.jsonl");
    await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: "before" } }) + "\n");
    const exact = target("live", "endpoint-a", "generation-a");
    const sibling = target("live", "endpoint-b", "generation-b");
    const registration = (value: typeof exact) => ({ target: value, sessionFile, capabilities: ["prompt"] as const, runtimeStatus: "idle" as const, transport: transport() });
    controller.desktopPlugins.register(registration(exact));
    controller.desktopPlugins.register(registration(sibling));
    controller.applyDesktopProjection([registration(exact), registration(sibling)]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    events = [];
    await appendFile(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "live" } }) + "\n");
    await vi.waitFor(() => {
      const items = events.filter((event) => (event as { type?: string }).type === "timeline_item") as Array<{ target?: unknown; item?: { text?: string }}>;
      expect(items.filter((event) => event.target === exact && event.item?.text === "live")).toHaveLength(1);
      expect(items.filter((event) => event.target === sibling && event.item?.text === "live")).toHaveLength(1);
    }, { timeout: 1500, interval: 50 });
  });

  it("replaces the exact target timeline after JSONL compaction", async () => {
    const sessionFile = join(tmpDir, "compact.jsonl");
    await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "old history ".repeat(100) } }) + "\n");
    const exact = target("compact");
    const registration = { target: exact, sessionFile, capabilities: ["prompt"] as const, runtimeStatus: "idle" as const, transport: transport() };
    controller.desktopPlugins.register(registration);
    controller.applyDesktopProjection([registration]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    events = [];
    await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "new" } }) + "\n");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "timeline_snapshot", target: exact, items: [expect.objectContaining({ text: "new" })] })), { timeout: 1500, interval: 50 });
    expect(events.some((event) => (event as { type?: string }).type === "timeline_item")).toBe(false);
  });

  it("emits exact-target execution summaries and clears only the disconnected sibling", () => {
    const exact = target("execution", "endpoint-a", "generation-a");
    const sibling = target("execution", "endpoint-b", "generation-b");
    const registration = (value: typeof exact) => ({ target: value, capabilities: ["abort"] as const, runtimeStatus: "idle" as const, transport: transport() });
    controller.desktopPlugins.register(registration(exact));
    controller.desktopPlugins.register(registration(sibling));
    controller.applyDesktopProjection([registration(exact), registration(sibling)]);
    const summary = {
      revision: 1,
      todos: [{ id: "todo-1", subject: "Ship", status: "in_progress", updatedAt: 1 }],
      teammate: { running: 1, total: 1, agents: [{ correlationId: "agent-1", agent: "general", status: "running" }] },
      backgroundJobs: [],
    };
    controller.applyDesktopProjection([
      { ...registration(exact), executionSummary: summary },
      registration(sibling),
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "session_execution_updated", summary: expect.objectContaining({ target: exact, revision: 1, todos: summary.todos }) }));
    events = [];
    controller.applyDesktopProjection([registration(exact), registration(sibling)]);
    expect(events).toContainEqual(expect.objectContaining({ type: "session_execution_updated", reset: true, summary: expect.objectContaining({ target: exact }) }));
    const resetRevision = (events.find((event) => (event as { type?: string }).type === "session_execution_updated") as { summary: { revision: number } }).summary.revision;
    events = [];
    controller.applyDesktopProjection([{ ...registration(exact), executionSummary: summary }, registration(sibling)]);
    expect(events).toContainEqual(expect.objectContaining({ type: "session_execution_updated", summary: expect.objectContaining({ target: exact, revision: resetRevision + 1, todos: summary.todos }) }));
    events = [];
    controller.desktopPlugins.unregister(exact);
    controller.applyDesktopProjection([registration(sibling)]);
    expect(events).toContainEqual(expect.objectContaining({ type: "session_execution_updated", reset: true, summary: expect.objectContaining({ target: exact, teammate: { running: 0, total: 0, agents: [] } }) }));
    expect(events.filter((event) => (event as { type?: string }).type === "session_execution_updated").every((event) => (event as { summary: { target: typeof exact } }).summary.target.endpointId === exact.endpointId)).toBe(true);
  });

  it("keeps execution revisions monotonic and replayable beyond 256 active targets", () => {
    const records = Array.from({ length: 260 }, (_, index) => {
      const value = target(`many-${index}`, `endpoint-${index}`, `generation-${index}`);
      const executionSummary = { revision: 1, todos: [], teammate: { running: 0, total: 0, agents: [] }, backgroundJobs: [] };
      controller.desktopPlugins.register({ target: value, capabilities: ["abort"], transport: transport(), executionSummary });
      return { target: value, capabilities: ["abort"] as const, runtimeStatus: "idle" as const, executionSummary, transport: transport() };
    });
    controller.applyDesktopProjection(records);
    const replay = controller.currentDesktopExecutionEvents();
    expect(replay).toHaveLength(260);
    const firstTarget = records[0].target;
    const firstRevision = (replay.find((event) => event.type === "session_execution_updated" && event.summary.target.sessionId === firstTarget.sessionId) as { summary: { revision: number } }).summary.revision;
    const updatedExecution = { ...records[0].executionSummary, revision: 2, todos: [{ id: "updated", subject: "Updated", status: "pending", updatedAt: 2 }] };
    controller.desktopPlugins.register({ ...records[0], executionSummary: updatedExecution });
    controller.applyDesktopProjection([
      { ...records[0], executionSummary: updatedExecution },
      ...records.slice(1),
    ]);
    const next = controller.currentDesktopExecutionEvents().find((event) => event.type === "session_execution_updated" && event.summary.target.sessionId === firstTarget.sessionId) as { summary: { revision: number; todos: Array<{ id: string }> } };
    expect(next.summary.revision).toBeGreaterThan(firstRevision);
    expect(next.summary.todos[0]?.id).toBe("updated");
  });

  it("keeps Desktop summary updates isolated by full target identity", () => {
    const exact = target("same", "endpoint-a", "generation-a");
    const sibling = target("same", "endpoint-b", "generation-b");
    const registration = (value: typeof exact) => ({ target: value, capabilities: ["abort"] as const, transport: transport() });
    controller.desktopPlugins.register(registration(exact));
    controller.registerDesktopTarget(exact);
    controller.desktopPlugins.register(registration(sibling));
    controller.registerDesktopTarget(sibling);
    controller.syncDesktopRuntimeStatus(exact, "running");
    controller.syncDesktopSessionSummary(exact, { runtimeStatus: "running", messageCount: 3 });
    expect(controller.directory.resolve(exact)?.runtimeStatus).toBe("running");
    expect(controller.directory.resolve(sibling)?.runtimeStatus).toBe("idle");
    expect(events.filter((event) => (event as { type?: string }).type === "session_summary_updated")).toHaveLength(2);
  });
});
