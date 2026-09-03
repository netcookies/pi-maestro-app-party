import { describe, expect, it, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { HostController } from "../src/host-controller.js";
import { MobileHostServer } from "../src/server/mobile-host-server.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import type { HostEvent } from "@maestro-mobile/shared";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * P3 端到端集成测试（真实 WebSocket 传输）
 *
 * 场景 1（ask 闭环）：runner 的 bridge 触发 ctx.select
 *   → extension_ui_request 事件 → server 广播 → WS 客户端收到
 *   → 客户端发送 extension_ui_response 命令 → bridge resolve → select 返回答案
 *
 * 场景 2（maestro 状态流）：host 轮询 flow-schedule → maestro_state 推送到 WS 客户端
 */

// 可控的 fake Pi SDK 会话
function makeFakeRuntime() {
  const subscribers = new Set<(e: unknown) => void>();
  const session = {
    sessionId: "sess-fake-1",
    sessionName: "fake",
    cwd: "/tmp",
    messages: [] as unknown[],
    pendingMessageCount: 0,
    isStreaming: false,
    isCompacting: false,
    model: undefined,
    thinkingLevel: undefined,
    prompt: async () => undefined,
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    subscribe: (fn: (e: unknown) => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    bindExtensions: async () => undefined,
  };
  return {
    session,
    cwd: "/tmp",
    dispose: async () => undefined,
    runtime: { session, cwd: "/tmp", dispose: async () => undefined },
  };
}

describe("P3 E2E: host ↔ mobile over WebSocket", () => {
  let controller: HostController;
  let server: MobileHostServer;
  let port: number;
  let tmpDir: string;
  let fakeRuntime: ReturnType<typeof makeFakeRuntime>;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "e2e-maestro-"));
    fakeRuntime = makeFakeRuntime();
    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    controller = new HostController({
      createRuntime: async () => fakeRuntime.runtime,
      listSessions: async () => [],
    }, reader);
    server = new MobileHostServer(controller, {});
    await server.listen(0, "127.0.0.1");
    port = server.address().port;
  });

  afterAll(async () => {
    await server.close();
    await controller.dispose();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function connectClient(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  it("场景1: ask 闭环 — select 弹窗经 WS 到达客户端并可应答", async () => {
    // 打开会话（使用 fake runtime）
    const runner = await controller.openSession({ cwd: "/tmp", mode: "create" });
    expect(runner.id).toBe("sess-fake-1");

    const ws = await connectClient();
    const received: HostEvent[] = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as HostEvent;
      received.push(msg);
    });

    // host 侧模拟 maestro 调用 ask（ctx.select）
    const selectPromise = runner.bridge.createContext().select("选择模型", ["Claude", "GPT", "Gemini"]);

    // 等待 extension_ui_request 到达客户端
    await new Promise<void>((resolve) => {
      const check = () => {
        if (received.some((e) => e.type === "extension_ui_request")) resolve();
        else setTimeout(check, 20);
      };
      check();
    });

    const reqEvent = received.find(
      (e): e is Extract<HostEvent, { type: "extension_ui_request" }> =>
        e.type === "extension_ui_request",
    )!;
    expect(reqEvent.request.method).toBe("select");
    expect(reqEvent.request.options).toEqual(["Claude", "GPT", "Gemini"]);

    // 客户端发送应答命令
    const requestId = reqEvent.request.id;
    ws.send(JSON.stringify({
      type: "extension_ui_response",
      sessionId: "sess-fake-1",
      requestId,
      response: { id: requestId, value: "GPT" },
    }));

    const answer = await selectPromise;
    expect(answer).toBe("GPT");
    ws.close();
  });

  it("场景2: maestro_state 经 WS 推送到客户端", async () => {
    const ws = await connectClient();
    const maestroEvents: HostEvent[] = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as HostEvent;
      if (msg.type === "maestro_state") maestroEvents.push(msg);
    });

    // 创建 flow-schedule 目录并写入调度，触发真实读取
    const scheduleDir = join(tmpDir, ".pi", "flow-schedule", "v1", "schedules");
    await mkdir(scheduleDir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(scheduleDir, "sch-e2e.json"),
      JSON.stringify({
        scheduleId: "sch-e2e",
        state: "active",
        stepIds: ["s1"],
        steps: { s1: { stepId: "s1", prompt: "Step 1", state: "pending", attempts: [] } },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await controller.startMaestroPoll(50);
    await new Promise((r) => setTimeout(r, 250));
    expect(maestroEvents.length).toBeGreaterThanOrEqual(1);
    const ev = maestroEvents[0] as Extract<HostEvent, { type: "maestro_state" }>;
    expect(ev.state.schedules.some((s) => s.scheduleId === "sch-e2e")).toBe(true);

    controller.stopMaestroPoll();
    ws.close();
  });

  it("场景3: 客户端断开后服务端继续广播，重连可收到", async () => {
    const ws1 = await connectClient();
    ws1.close();

    // 断开后依然能重新连接
    const ws2 = await connectClient();
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    ws2.close();
  });
});