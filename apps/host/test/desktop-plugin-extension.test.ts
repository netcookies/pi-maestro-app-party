import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopPluginExecutionSummary, DesktopPluginResult, DesktopPluginModel, DesktopPluginRuntimeStatus, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DesktopPluginIpcServer } from "../src/plugin/desktop-plugin-ipc.js";
import { DesktopControlGatewayService } from "../src/control/desktop-control-gateway.js";
import { DesktopPluginRegistry } from "../src/plugin/desktop-plugin-registry.js";
import { createDesktopPluginExtension } from "../src/plugin/desktop-plugin-extension.js";

/** 最小假 Pi API/ctx：只保真 extension 实际使用的成员，避免用宽泛 mock 掩盖真实调用。 */
function fakePi(options: { models: { provider: string; id: string; name: string }[]; availableModels?: { provider: string; id: string; name: string }[]; skills?: { name: string; description?: string }[]; model?: unknown; configuredAuth?: boolean; entries?: unknown[] }) {
  let sessionEntries = options.entries ?? [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const eventHandlers = new Map<string, ((payload: unknown) => void)[]>();
  const setModelCalls: unknown[] = [];
  const setThinkingCalls: string[] = [];
  let thinkingLevel = "medium";
  let sessionId = "tui-session";
  const sent: { content: unknown; options?: { deliverAs?: string } }[] = [];
  const pi = {
    events: {
      on(event: string, handler: (payload: unknown) => void) {
        eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
        return () => eventHandlers.set(event, (eventHandlers.get(event) ?? []).filter((candidate) => candidate !== handler));
      },
      emit(event: string, payload: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload);
      },
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendUserMessage(content: unknown, sendOptions?: { deliverAs?: string }) {
      sent.push({ content, options: sendOptions });
    },
    getAllTools: () => [],
    getCommands: () => (options.skills ?? []).map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" })),
    setModel: async (model: unknown) => {
      setModelCalls.push(model);
      return true;
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level: string) => {
      const previousLevel = thinkingLevel;
      thinkingLevel = level;
      setThinkingCalls.push(level);
      for (const handler of handlers.get("thinking_level_select") ?? []) {
        handler({ type: "thinking_level_select", level, previousLevel }, ctx);
      }
    },
  };
  const ctx = {
    cwd: "/work/app",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      getEntries: () => sessionEntries,
    },
    model: options.model === undefined
      ? { provider: "provider-a", id: "shared-id", name: "Model A", reasoning: true, input: ["text"] }
      : options.model,
    modelRegistry: {
      find: (provider: string, id: string) => options.models.find((m) => m.provider === provider && m.id === id),
      getAll: () => options.models,
      getAvailable: () => options.availableModels ?? options.models,
      hasConfiguredAuth: () => options.configuredAuth ?? true,
    },
    isIdle: () => true,
    abort: () => {},
  };
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
  };
  const emitAsync = async (event: string, payload: unknown): Promise<void> => {
    await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));
  };
  return {
    pi,
    ctx,
    setModelCalls,
    setThinkingCalls,
    sent,
    emit,
    emitAsync,
    handlers,
    emitBus: (event: string, payload: unknown) => pi.events.emit(event, payload),
    setSessionId: (nextSessionId: string) => { sessionId = nextSessionId; },
    setSessionEntries: (entries: unknown[]) => { sessionEntries = entries; },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}

describe("Desktop Plugin extension (TUI side)", () => {
  let server: DesktopPluginIpcServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("switches TUI model/thinking in-process and reports their state events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-"));
    const registry = new DesktopPluginRegistry();
    const received: DesktopPluginModel[] = [];
    const thinkingLevels: string[] = [];
    const runtimeStatuses: DesktopPluginRuntimeStatus[] = [];
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      registry,
      supportedEvents: ["model_select", "thinking_level_select", "runtime_status"],
      onModelSelect: (_target, event) => { received.push(event.model); },
      onThinkingLevelSelect: (_target, event) => { thinkingLevels.push(event.level); },
      onRuntimeStatus: (_target, event) => { runtimeStatuses.push(event.runtimeStatus); },
    });
    await server.start();

    const fake = fakePi({
      models: [{ provider: "provider-b", id: "shared-id", name: "Model B" }],
      availableModels: [],
      model: { provider: "provider-b", id: "shared-id", name: "Model B", reasoning: false, input: ["text", "image"] },
      skills: [{ name: "review", description: "Review changes" }],
    });
    const extension = createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" });
    extension(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });

    await waitFor(() => registry.list().length > 0);
    await waitFor(() => runtimeStatuses.includes("idle") && thinkingLevels.includes("medium"));
    const target = registry.list()[0].target;
    expect(target.sessionId).toBe("tui-session");
    expect(registry.list()[0].sessionFile).toBe("/sessions/tui-session.jsonl");
    expect(registry.hasCapability(target, "set_model")).toBe(true);
    expect(registry.hasCapability(target, "set_thinking")).toBe(true);
    expect(registry.hasCapability(target, "list_models")).toBe(true);
    expect(registry.hasCapability(target, "list_skills")).toBe(true);

    fake.emit("agent_start", { type: "agent_start" });
    await waitFor(() => runtimeStatuses.at(-1) === "running");
    fake.emit("agent_end", { type: "agent_end", messages: [] });
    await waitFor(() => runtimeStatuses.at(-1) === "idle");

    // Host → TUI: 必须命中 provider/id 并用同一个进程的 API 切换模型
    const gateway = new DesktopControlGatewayService(registry);
    await expect(gateway.query(target, "list_models")).resolves.toEqual([
      { provider: "provider-b", id: "shared-id", name: "Model B", reasoning: false, vision: true },
    ]);
    await expect(gateway.query(target, "list_skills")).resolves.toEqual([
      { name: "review", description: "Review changes" },
    ]);
    const result = await gateway.execute({ requestId: "ext-set-model", target: target as DesktopPluginTarget, kind: "set_model", provider: "provider-b", modelId: "shared-id" });
    expect(result).toMatchObject({ status: "observed" });
    expect(fake.setModelCalls).toEqual([{ provider: "provider-b", id: "shared-id", name: "Model B" }]);

    const thinkingResult = await registry.resolve(target)!.transport.request({
      type: "desktop_plugin_request",
      requestId: "ext-set-thinking",
      commandId: "ext-set-thinking",
      deadlineAt: Date.now() + 1000,
      target,
      operation: { type: "set_thinking", level: "high" },
    });
    expect(thinkingResult).toMatchObject({ status: "accepted" });
    expect(fake.setThinkingCalls).toEqual(["high"]);
    await waitFor(() => thinkingLevels.at(-1) === "high");

    // 未知模型必须失败而非静默
    const missing = await gateway.execute({ requestId: "ext-missing", target: target as DesktopPluginTarget, kind: "set_model", provider: "provider-z", modelId: "nope" });
    expect(missing).toMatchObject({ status: "failed", error: { code: "model_change_failed" } });

    // TUI → Host: 用户在 TUI 内切换模型后必须上报结构化事件
    fake.emit("model_select", {
      type: "model_select",
      model: { provider: "provider-b", id: "shared-id", name: "Model B", reasoning: false, input: ["text", "image"] },
      previousModel: undefined,
      source: "cycle",
    });
    await waitFor(() => received.some((model) => model.provider === "provider-b"));
    expect(received.at(-1)).toEqual({ provider: "provider-b", id: "shared-id", name: "Model B", reasoning: false, vision: true });
  });

  it("publishes bounded same-process Todo, teammate, and background execution data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-execution-"));
    const providerKey = Symbol.for("pi-maestro.workspace-projection-providers.v1");
    const globals = globalThis as Record<symbol, unknown>;
    const previousProviders = globals[providerKey];
    globals[providerKey] = new Map([
      ["todo", {
        kind: "todo",
        snapshot: () => [{ kind: "todo", data: { id: "todo-1", subject: "Ship", status: "in_progress", updatedAt: 1, assigneeLabel: "root" } }],
      }],
    ]);
    const teammateKey = Symbol.for("pi-maestro-teammate.root-registry");
    const previousTeammate = globals[teammateKey];
    globals[teammateKey] = {
      currentWorkspaceId: "workspace-1",
      currentSessionId: "tui-session",
      currentSourceId: "source-1",
      sessionGeneration: 1,
    };
    try {
      const summaries: DesktopPluginExecutionSummary[] = [];
      const registry = new DesktopPluginRegistry();
      server = new DesktopPluginIpcServer({
        socketPath: join(dir, "plugin.sock"),
        secret: "test-secret",
        registry,
        supportedEvents: ["execution_summary"],
        onExecutionSummary: (_target, event) => { summaries.push(event.summary); },
      });
      await server.start();
      const fake = fakePi({ models: [] });
      createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" })(fake.pi as never);
      fake.emit("session_start", { type: "session_start", reason: "startup" });
      await waitFor(() => registry.list()[0]?.executionSummary?.todos[0]?.id === "todo-1");
      const initialRevision = registry.list()[0].executionSummary!.revision;
      fake.emitBus("teammate:started", {
        projection: { workspaceId: "workspace-1", sessionId: "tui-session", sourceId: "source-1", generation: 1 },
        correlationId: "agent-1", agent: "general", status: "running", name: "reviewer",
      });
      fake.emitBus("bash-bg:update", { jobs: [{ id: "job-1", command: "pnpm test", cwd: "/work/app", pid: 10, status: "running", startedAt: 1, updatedAt: 2, exitCode: null, outputTail: "", outputBytes: 0, logPath: "/tmp/job.log" }] });
      await waitFor(() => registry.list()[0]?.executionSummary?.teammate.agents[0]?.correlationId === "agent-1");
      await waitFor(() => registry.list()[0]?.executionSummary?.backgroundJobs[0]?.id === "job-1");
      const execution = registry.list()[0].executionSummary!;
      expect(execution.teammate).toMatchObject({ running: 1, total: 1 });
      expect(execution.backgroundJobs).toEqual([expect.objectContaining({ id: "job-1", status: "running", label: "pnpm test" })]);
      expect(summaries.some((summary) => summary.teammate.agents.some((agent) => agent.correlationId === "agent-1"))).toBe(true);
      expect(execution.revision).toBeGreaterThan(initialRevision);
      for (let index = 0; index < 70; index += 1) {
        fake.emitBus("teammate:started", {
          projection: { workspaceId: "workspace-1", sessionId: "tui-session", sourceId: "source-1", generation: 1 },
          correlationId: `agent-${index + 2}`, agent: "general", status: "running",
        });
      }
      await waitFor(() => registry.list()[0]?.executionSummary?.teammate.agents.at(-1)?.correlationId === "agent-71");
      expect(registry.list()[0]?.executionSummary?.teammate.total).toBe(64);
      const bounded = structuredClone(registry.list()[0].executionSummary!);
      fake.emitBus("teammate:started", {
        projection: { workspaceId: "workspace-2", sessionId: "sibling", sourceId: "source-2", generation: 1 },
        correlationId: "sibling-agent", agent: "general", status: "running",
      });
      expect(() => fake.emitBus("bash-bg:update", { jobs: [{ id: "bad", command: "bad", cwd: "/work/app", pid: 1, status: "running", startedAt: Number.MAX_VALUE, updatedAt: 1, exitCode: null, outputTail: "", outputBytes: 0, logPath: "/tmp/bad.log" }] })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(registry.list()[0].executionSummary).toEqual(bounded);
      expect(registry.list()[0].executionSummary?.teammate.agents.some((agent) => agent.correlationId === "sibling-agent")).toBe(false);
      globals[teammateKey] = {
        currentWorkspaceId: "workspace-1",
        currentSessionId: "tui-session",
        currentSourceId: "source-2",
        sessionGeneration: 2,
      };
      fake.emitBus("teammate:started", {
        projection: { workspaceId: "workspace-1", sessionId: "tui-session", sourceId: "source-1", generation: 1 },
        correlationId: "old-fence-agent", agent: "general", status: "running",
      });
      fake.emitBus("maestro:todo-state-changed", { version: 1 });
      await waitFor(() => registry.list()[0]?.executionSummary?.teammate.total === 0);
      fake.emitBus("teammate:started", {
        projection: { workspaceId: "workspace-1", sessionId: "tui-session", sourceId: "source-2", generation: 2 },
        correlationId: "new-fence-agent", agent: "general", status: "running",
      });
      await waitFor(() => registry.list()[0]?.executionSummary?.teammate.agents[0]?.correlationId === "new-fence-agent");
    } finally {
      if (previousProviders === undefined) delete globals[providerKey];
      else globals[providerKey] = previousProviders;
      if (previousTeammate === undefined) delete globals[teammateKey];
      else globals[teammateKey] = previousTeammate;
    }
  });

  it("lists the bound model when Pi has no available or catalog snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-model-fallback-"));
    const registry = new DesktopPluginRegistry();
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      registry,
    });
    await server.start();

    const fake = fakePi({
      models: [],
      availableModels: [],
      model: { provider: "provider-live", id: "live-model", name: "Live model", reasoning: true, input: ["text", "image"] },
    });
    createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" })(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });

    await waitFor(() => registry.list().length > 0);
    await expect(new DesktopControlGatewayService(registry).query(registry.list()[0].target, "list_models")).resolves.toEqual([
      { provider: "provider-live", id: "live-model", name: "Live model", reasoning: true, vision: true },
    ]);
  });

  it("shuts down an in-flight connection setup without creating a zombie client", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-shutdown-connect-"));
    const registry = new DesktopPluginRegistry();
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      registry,
    });
    await server.start();

    const fake = fakePi({ models: [] });
    createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" })(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });
    await fake.emitAsync("session_shutdown", { type: "session_shutdown" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.list()).toHaveLength(0);
  });

  it("does not let an old connection attempt take over a restarted session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-restart-connect-"));
    const socketPath = join(dir, "plugin.sock");
    const registry = new DesktopPluginRegistry();
    server = new DesktopPluginIpcServer({ socketPath, secret: "test-secret", registry });
    await server.start();

    const fake = fakePi({ models: [] });
    createDesktopPluginExtension({ socketPath, secret: "test-secret" })(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });
    const shutdown = fake.emitAsync("session_shutdown", { type: "session_shutdown" });
    fake.setSessionId("restarted-session");
    fake.emit("session_start", { type: "session_start", reason: "switch" });
    await shutdown;

    await waitFor(() => registry.list().length === 1);
    const target = registry.list()[0].target as DesktopPluginTarget;
    expect(target.sessionId).toBe("restarted-session");
    expect(registry.list()[0].sessionFile).toBe("/sessions/restarted-session.jsonl");
    const gateway = new DesktopControlGatewayService(registry);
    await expect(gateway.execute({ requestId: "restart-prompt", target, kind: "prompt", message: "hello" }))
      .resolves.toMatchObject({ status: "accepted" });
    expect(fake.sent).toHaveLength(1);

    await fake.emitAsync("session_shutdown", { type: "session_shutdown" });
    await waitFor(() => registry.list().length === 0);
  });

  it("collects root Todo state from the durable session snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-root-todo-"));
    const registry = new DesktopPluginRegistry();
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      registry,
      supportedEvents: ["execution_summary"],
    });
    await server.start();
    const fake = fakePi({
      models: [],
      entries: [{ type: "custom", customType: "todo-state", data: { version: 8, tasks: { "todo-root": { id: "todo-root", subject: "Root task", status: "pending", updatedAt: 10, assignee: { label: "root" } } } } }],
    });
    createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" })(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => registry.list()[0]?.executionSummary?.todos[0]?.id === "todo-root");
    expect(registry.list()[0]?.executionSummary?.todos).toEqual([{ id: "todo-root", subject: "Root task", status: "pending", updatedAt: 10, assigneeLabel: "root" }]);
  });

  it("publishes an empty root Todo summary when no durable Todo state exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-empty-todo-"));
    const registry = new DesktopPluginRegistry();
    server = new DesktopPluginIpcServer({ socketPath: join(dir, "plugin.sock"), secret: "test-secret", registry, supportedEvents: ["execution_summary"] });
    await server.start();
    const fake = fakePi({ models: [], entries: [] });
    createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" })(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => registry.list()[0]?.executionSummary?.todos.length === 0);
    expect(registry.list()[0]?.executionSummary?.todos).toEqual([]);
  });
  it("reconnects and re-reports current model, thinking level, and execution summary after the socket drops", async () => {
    const providerKey = Symbol.for("pi-maestro.workspace-projection-providers.v1");
    const globals = globalThis as Record<symbol, unknown>;
    const previousProviders = globals[providerKey];
    globals[providerKey] = new Map([["todo", { kind: "todo", snapshot: () => [{ kind: "todo", data: { id: "todo-reconnect", subject: "Reconnect", status: "pending", updatedAt: 1 } }] }]]);
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-reconnect-"));
    const socketPath = join(dir, "plugin.sock");
    const registry = new DesktopPluginRegistry();
    const received: DesktopPluginModel[] = [];
    const thinkingLevels: string[] = [];
    server = new DesktopPluginIpcServer({
      socketPath,
      secret: "test-secret",
      registry,
      supportedEvents: ["thinking_level_select", "execution_summary"],
      onModelSelect: (_target, event) => { received.push(event.model); },
      onThinkingLevelSelect: (_target, event) => { thinkingLevels.push(event.level); },
    });
    await server.start();

    const fake = fakePi({ models: [] });
    const extension = createDesktopPluginExtension({ socketPath, secret: "test-secret" });
    extension(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => registry.list().length > 0);
    const target = registry.list()[0].target;

    // 重连后必须重发当前模型，否则 Host 会一直显示旧模型
    fake.emit("model_select", {
      type: "model_select",
      model: { provider: "provider-c", id: "model-c", name: "Model C", reasoning: false, input: ["text"] },
      previousModel: undefined,
      source: "set",
    });
    await waitFor(() => received.length > 0);
    fake.pi.setThinkingLevel("xhigh");
    await waitFor(() => thinkingLevels.at(-1) === "xhigh");
    const thinkingReportsBeforeReconnect = thinkingLevels.filter((level) => level === "xhigh").length;
    await waitFor(() => registry.list()[0]?.executionSummary?.todos[0]?.id === "todo-reconnect");

    await server.close();
    server = undefined;
    await waitFor(() => registry.list().length === 0);

    const restarted = new DesktopPluginIpcServer({
      socketPath,
      secret: "test-secret",
      registry,
      supportedEvents: ["thinking_level_select", "execution_summary"],
      onModelSelect: (_target, event) => { received.push(event.model); },
      onThinkingLevelSelect: (_target, event) => { thinkingLevels.push(event.level); },
    });
    server = restarted;
    await restarted.start();

    await waitFor(() => received.some((model) => model.id === "model-c") && restarted.registry.list().length > 0);
    await waitFor(() => thinkingLevels.filter((level) => level === "xhigh").length > thinkingReportsBeforeReconnect);
    await waitFor(() => restarted.registry.list()[0]?.executionSummary?.todos[0]?.id === "todo-reconnect");
    expect(restarted.registry.hasCapability(target as DesktopPluginTarget, "set_model")).toBe(true);
    if (previousProviders === undefined) delete globals[providerKey];
    else globals[providerKey] = previousProviders;
  });

  it("always asks Pi to queue prompt as steer so streaming never drops it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-deliver-"));
    const registry = new DesktopPluginRegistry();
    const runtimeStatuses: DesktopPluginRuntimeStatus[] = [];
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      registry,
      supportedEvents: ["runtime_status"],
      onRuntimeStatus: (_target, event) => { runtimeStatuses.push(event.runtimeStatus); },
    });
    await server.start();

    const fake = fakePi({ models: [] });
    const extension = createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" });
    extension(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => registry.list().length > 0);
    const target = registry.list()[0].target as DesktopPluginTarget;

    // Pi 仅在 AgentSession 处于 streaming 时读取 deliverAs；因此传 steer 使空闲=新轮次、
    // 流式中=入队 steer，与 host 侧「streaming 自动降级为 steer」语义一致。
    const gateway = new DesktopControlGatewayService(registry);
    // `sendUserMessage` 是 fire-and-forget；`accepted` 只表示 Pi 接受异步处理请求。
    // 只有 agent_start/agent_end 事件才能建立后续的 `running`/`idle` 生命周期证据。
    await expect(gateway.execute({ requestId: "d1", target, kind: "prompt", message: "hello" })).resolves.toMatchObject({ status: "accepted" });
    expect(fake.sent.at(-1)?.options).toEqual({ deliverAs: "steer" });

    // 以 "/" 开头的消息仍是合法消息（sendUserMessage 绕过扩展命令解析），不得被预检拦截。
    await expect(gateway.execute({ requestId: "d2", target, kind: "prompt", message: "/skill:foo bar" })).resolves.toMatchObject({ status: "accepted" });
    expect(fake.sent.at(-1)?.options).toEqual({ deliverAs: "steer" });

    expect(fake.sent).toHaveLength(2);

    // `accepted` 后由真实 runtime 生命周期确认，驱动 Mobile 的 running/idle 投影。
    fake.emit("agent_start", { type: "agent_start" });
    await waitFor(() => runtimeStatuses.at(-1) === "running");
    fake.emit("agent_end", { type: "agent_end", messages: [] });
    await waitFor(() => runtimeStatuses.at(-1) === "idle");
  });

  it("reports delivery_failed instead of a silent observed when delivery is impossible", async () => {
    const dispatch = async (
      dir: string,
      fake: ReturnType<typeof fakePi>,
    ): Promise<{ status: string; error?: { code?: string; message?: string } }> => {
      const socketPath = join(dir, "plugin.sock");
      const registry = new DesktopPluginRegistry();
      const scenarioServer = new DesktopPluginIpcServer({ socketPath, secret: "test-secret", registry });
      await scenarioServer.start();
      const extension = createDesktopPluginExtension({ socketPath, secret: "test-secret" });
      extension(fake.pi as never);
      fake.emit("session_start", { type: "session_start", reason: "startup" });
      await waitFor(() => registry.list().length > 0);
      const target = registry.list()[0].target as DesktopPluginTarget;
      const gateway = new DesktopControlGatewayService(registry);
      const result = await gateway.execute({ requestId: `fail-${dir}`, target, kind: "prompt", message: "hello" });
      await scenarioServer.close();
      return result as { status: string; error?: { code?: string; message?: string } };
    };

    const noModelDir = await mkdtemp(join(tmpdir(), "maestro-ext-nomodel-"));
    const noModel = fakePi({ models: [], model: null });
    const noModelResult = await dispatch(noModelDir, noModel);
    expect(noModelResult.status).toBe("failed");
    // code 是稳定的可判别码；具体原因走 message，便于诊断而不破坏机器可读性。
    expect(noModelResult.error?.code).toBe("delivery_failed");
    expect(noModelResult.error?.message).toBe("no_model_selected");
    expect(noModel.sent).toHaveLength(0);

    const noAuthDir = await mkdtemp(join(tmpdir(), "maestro-ext-noauth-"));
    const noAuth = fakePi({ models: [], configuredAuth: false });
    const noAuthResult = await dispatch(noAuthDir, noAuth);
    expect(noAuthResult.status).toBe("failed");
    expect(noAuthResult.error?.code).toBe("delivery_failed");
    expect(noAuthResult.error?.message).toBe("missing_model_auth");
    expect(noAuth.sent).toHaveLength(0);
  });
});
