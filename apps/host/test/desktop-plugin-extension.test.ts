import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopPluginResult, DesktopPluginModel, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DesktopPluginIpcServer } from "../src/plugin/desktop-plugin-ipc.js";
import { DesktopControlGatewayService } from "../src/control/desktop-control-gateway.js";
import { DesktopPluginRegistry } from "../src/plugin/desktop-plugin-registry.js";
import { createDesktopPluginExtension } from "../src/plugin/desktop-plugin-extension.js";

/** 最小假 Pi API/ctx：只保真 extension 实际使用的成员，避免用宽泛 mock 掩盖真实调用。 */
function fakePi(options: { models: { provider: string; id: string; name: string }[]; model?: unknown; configuredAuth?: boolean }) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const setModelCalls: unknown[] = [];
  const sent: { content: unknown; options?: { deliverAs?: string } }[] = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendUserMessage(content: unknown, sendOptions?: { deliverAs?: string }) {
      sent.push({ content, options: sendOptions });
    },
    getAllTools: () => [],
    setModel: async (model: unknown) => {
      setModelCalls.push(model);
      return true;
    },
  };
  const ctx = {
    cwd: "/work/app",
    sessionManager: { getSessionId: () => "tui-session" },
    model: options.model === undefined
      ? { provider: "provider-a", id: "shared-id", name: "Model A", reasoning: true, input: ["text"] }
      : options.model,
    modelRegistry: {
      find: (provider: string, id: string) => options.models.find((m) => m.provider === provider && m.id === id),
      getAll: () => options.models,
      hasConfiguredAuth: () => options.configuredAuth ?? true,
    },
    abort: () => {},
  };
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
  };
  return { pi, ctx, setModelCalls, sent, emit, handlers };
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

  it("switches the TUI model in-process and reports model_select to the Host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-"));
    const registry = new DesktopPluginRegistry();
    const received: DesktopPluginModel[] = [];
    server = new DesktopPluginIpcServer({
      socketPath: join(dir, "plugin.sock"),
      secret: "test-secret",
      registry,
      onModelSelect: (_target, event) => { received.push(event.model); },
    });
    await server.start();

    const fake = fakePi({ models: [{ provider: "provider-b", id: "shared-id", name: "Model B" }] });
    const extension = createDesktopPluginExtension({ socketPath: join(dir, "plugin.sock"), secret: "test-secret" });
    extension(fake.pi as never);
    fake.emit("session_start", { type: "session_start", reason: "startup" });

    await waitFor(() => registry.list().length > 0);
    const target = registry.list()[0].target;
    expect(target.sessionId).toBe("tui-session");
    expect(registry.hasCapability(target, "set_model")).toBe(true);

    // Host → TUI: 必须命中 provider/id 并用同一个进程的 API 切换模型
    const gateway = new DesktopControlGatewayService(registry);
    const result = await gateway.execute({ requestId: "ext-set-model", target: target as DesktopPluginTarget, kind: "set_model", provider: "provider-b", modelId: "shared-id" });
    expect(result).toMatchObject({ status: "observed" });
    expect(fake.setModelCalls).toEqual([{ provider: "provider-b", id: "shared-id", name: "Model B" }]);

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

  it("reconnects and re-reports the current model after the socket drops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-reconnect-"));
    const socketPath = join(dir, "plugin.sock");
    const registry = new DesktopPluginRegistry();
    const received: DesktopPluginModel[] = [];
    server = new DesktopPluginIpcServer({
      socketPath,
      secret: "test-secret",
      registry,
      onModelSelect: (_target, event) => { received.push(event.model); },
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

    await server.close();
    server = undefined;
    await waitFor(() => registry.list().length === 0);

    const restarted = new DesktopPluginIpcServer({ socketPath, secret: "test-secret", registry, onModelSelect: (_target, event) => { received.push(event.model); } });
    server = restarted;
    await restarted.start();

    await waitFor(() => received.some((model) => model.id === "model-c") && restarted.registry.list().length > 0);
    expect(restarted.registry.hasCapability(target as DesktopPluginTarget, "set_model")).toBe(true);
  });

  it("always asks Pi to queue prompt as steer so streaming never drops it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ext-deliver-"));
    const registry = new DesktopPluginRegistry();
    server = new DesktopPluginIpcServer({ socketPath: join(dir, "plugin.sock"), secret: "test-secret", registry });
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
    await expect(gateway.execute({ requestId: "d1", target, kind: "prompt", message: "hello" })).resolves.toMatchObject({ status: "observed" });
    expect(fake.sent.at(-1)?.options).toEqual({ deliverAs: "steer" });

    // 以 "/" 开头的消息仍是合法消息（sendUserMessage 绕过扩展命令解析），不得被预检拦截。
    await expect(gateway.execute({ requestId: "d2", target, kind: "prompt", message: "/skill:foo bar" })).resolves.toMatchObject({ status: "observed" });
    expect(fake.sent.at(-1)?.options).toEqual({ deliverAs: "steer" });

    expect(fake.sent).toHaveLength(2);
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
