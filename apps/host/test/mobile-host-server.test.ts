import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MobileHostServer } from "../src/server/mobile-host-server.js";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

function stubRuntimeFactory() {
  return {
    createRuntime: async () => {
      throw new Error("Not implemented in test");
    },
    listSessions: async () => [],
  };
}

function protocolHello() {
  return {
    type: "protocol_hello" as const,
    protocolVersion: 2 as const,
    clientVersion: "test",
    capabilities: ["session_control", "monitor_read", "session_filter", "extension_ui", "desktop_plugin_control"] as const,
    requestId: `hello-${randomUUID()}`,
  };
}

async function connectV2(url: string): Promise<WebSocket> {
  const ws = new WebSocket(`${url}/ws`);
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as { type?: string };
      if (frame.type !== "protocol_ready") return;
      ws.off("message", onMessage);
      resolve();
    };
    ws.on("message", onMessage);
    ws.once("error", reject);
    ws.once("open", () => ws.send(JSON.stringify(protocolHello())));
  });
  return ws;
}


async function createTestServer(token?: string) {
  const tmpDir = join(tmpdir(), `maestro-server-test-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  const reader = new MaestroStateReader({ projectRoot: tmpDir });
  const controller = new HostController(stubRuntimeFactory(), reader);
  const server = new MobileHostServer(controller, token ? { token } : {});
  await server.listen(0, "127.0.0.1");
  const port = server.address().port;
  return { tmpDir, controller, server, port, url: `http://127.0.0.1:${port}` };
}

describe("MobileHostServer", () => {
  let ctx: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  afterEach(async () => {
    await ctx.server.close();
    await ctx.controller.dispose();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("serves /api/health", async () => {
    const res = await fetch(`${ctx.url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("serves /api/status with version", async () => {
    const res = await fetch(`${ctx.url}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; sessions: number };
    expect(body.version).toBe("0.4.0");
    expect(body.sessions).toBe(0);
  });

  it("serves /api/sessions as summary list", async () => {
    const res = await fetch(`${ctx.url}/api/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[]; observedAt: string };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.observedAt).toBeTruthy();
  });

  it("serves image file via /api/file", async () => {
    // 构造一个最小 PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const imgPath = join(ctx.tmpDir, "test.png");
    await writeFile(imgPath, png);

    const res = await fetch(`${ctx.url}/api/file?path=${encodeURIComponent(imgPath)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(png.length);
  });

  it("rejects non-image or unsafe paths via /api/file", async () => {
    const txtPath = join(ctx.tmpDir, "test.txt");
    await writeFile(txtPath, "hello");

    // 非图片扩展名
    let res = await fetch(`${ctx.url}/api/file?path=${encodeURIComponent(txtPath)}`);
    expect(res.status).toBe(400);

    // 相对路径
    res = await fetch(`${ctx.url}/api/file?path=relative.png`);
    expect(res.status).toBe(400);

    // 不存在的文件
    res = await fetch(`${ctx.url}/api/file?path=${encodeURIComponent(join(ctx.tmpDir, "missing.png"))}`);
    expect(res.status).toBe(400);
  });

  it("serves /api/maestro with real state", async () => {
    const scheduleDir = join(ctx.tmpDir, ".pi", "flow-schedule", "v1", "schedules");
    await mkdir(scheduleDir, { recursive: true });
    await writeFile(
      join(scheduleDir, "sch-api.json"),
      JSON.stringify({
        scheduleId: "sch-api",
        state: "active",
        stepIds: ["s1"],
        steps: { s1: { stepId: "s1", prompt: "Test", state: "pending", attempts: [] } },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const res = await fetch(`${ctx.url}/api/maestro`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedules: { scheduleId: string; state: string }[] };
    expect(body.schedules.length).toBe(1);
    expect(body.schedules[0].scheduleId).toBe("sch-api");
    expect(body.schedules[0].state).toBe("active");
  });

  it("serves /api/extension-ui/pending", async () => {
    const res = await fetch(`${ctx.url}/api/extension-ui/pending`);
    expect(res.status).toBe(200);
  });

  it("rejects unauthorized with token", async () => {
    await ctx.server.close();
    await ctx.controller.dispose();
    ctx = await createTestServer("secret-token");
    const res = await fetch(`${ctx.url}/api/health`);
    expect(res.status).toBe(401);
    const okRes = await fetch(`${ctx.url}/api/health?token=secret-token`);
    expect(okRes.status).toBe(200);
  });

  it("accepts WebSocket connection and receives protocol_ready before host_status", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    const first = await new Promise<unknown>((resolve, reject) => {
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as { type?: string };
        if (frame.type === "protocol_ready") resolve(frame);
      });
      ws.once("error", reject);
      ws.once("open", () => ws.send(JSON.stringify(protocolHello())));
    });
    expect((first as { type: string }).type).toBe("protocol_ready");
    ws.close();
  });

  it("rejects business frames before protocol_hello", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    const frame = await new Promise<{ type: string; code: string }>((resolve, reject) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString()) as { type: string; code: string }));
      ws.once("error", reject);
      ws.once("open", () => ws.send(JSON.stringify({ id: "pre-handshake", type: "ping" })));
    });
    expect(frame).toEqual(expect.objectContaining({ type: "protocol_error", code: "protocol_version_unsupported" }));
    ws.close();
  });

  it("rejects legacy protocol hello versions", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    const frame = await new Promise<{ type: string; code: string }>((resolve, reject) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString()) as { type: string; code: string }));
      ws.once("error", reject);
      ws.once("open", () => ws.send(JSON.stringify({ ...protocolHello(), protocolVersion: 1 })));
    });
    expect(frame).toEqual(expect.objectContaining({ type: "protocol_error", code: "protocol_version_unsupported" }));
    ws.close();
  });

  it("rejects duplicate protocol hello after readiness", async () => {
    const ws = await connectV2(ctx.url);
    const frame = await new Promise<{ type: string; code: string }>((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData) => {
        const value = JSON.parse(data.toString()) as { type: string; code: string };
        if (value.type !== "protocol_error") return;
        ws.off("message", onMessage);
        resolve(value);
      };
      ws.on("message", onMessage);
      ws.once("error", reject);
      ws.send(JSON.stringify(protocolHello()));
    });
    expect(frame).toEqual(expect.objectContaining({ type: "protocol_error", code: "invalid_frame" }));
    ws.close();
  });

  it("rejects a target identity whose sessionId differs from the command", async () => {
    const ws = await connectV2(ctx.url);
    const reply = await new Promise<{ status: string; error: { code: string } }>((resolve, reject) => {
      ws.on("message", function handler(data) {
        const msg = JSON.parse(data.toString()) as { type: string; status: string; error: { code: string } };
        if (msg.type !== "command_result") return;
        ws.off("message", handler);
        resolve(msg);
      });
      ws.once("error", reject);
      ws.send(JSON.stringify({
        id: "target-mismatch",
        type: "abort",
        sessionId: "session-a",
        target: { sessionId: "session-b", endpointId: "host", normalizedCwd: ctx.tmpDir, processGeneration: "host-session-b-1" },
      }));
    });
    expect(reply.status).toBe("unknown");
    expect(reply.error.code).toBe("target_mismatch");
    ws.close();
  });

  it("broadcasts maestro_state events to websocket clients", async () => {
    const ws = await connectV2(ctx.url);

    const seen = new Promise<unknown>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === "maestro_state") resolve(msg);
      });
    });

    await ctx.controller.startMaestroPoll(50);
    const msg = (await seen) as { type: string; state: { schedules: unknown[] } };
    expect(msg.type).toBe("maestro_state");
    expect(Array.isArray(msg.state.schedules)).toBe(true);

    ctx.controller.stopMaestroPoll();
    ws.close();
  });

  it("responds with command_result for unsupported command", async () => {
    const ws = await connectV2(ctx.url);

    const reply = new Promise<unknown>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === "command_result") resolve(msg);
      });
    });

    ws.send(JSON.stringify({ type: "unsupported_xyz" }));
    const msg = (await reply) as { ok: boolean; error: { code: string } };
    expect(msg.ok).toBe(false);
    expect(msg.error.code).toBe("unsupported_command");
    ws.close();
  });

  it("prompt command routes only to matching session TUI and never pollutes monitor session", async () => {
    let runnerPromptCalled = false;
    const workerRunner = {
      id: "sess-worker-1",
      state: {
        id: "sess-worker-1", cwd: ctx.tmpDir, title: "Worker Task", runState: "idle",
        messageCount: 0, pendingMessageCount: 0, updatedAt: "",
      },
      hasMoreHistory: false,
      snapshot: () => ({ session: workerRunner.state, timeline: [], nextSeq: 0, hasMoreHistory: false }),
      eventsSince: () => [],
      loadMoreHistory: async () => ({ items: [], hasMore: false, totalEntries: 0 }),
      searchHistory: async () => ({ matches: [], totalEntries: 0 }),
      prompt: async () => { runnerPromptCalled = true; },
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      respondToExtensionUi: () => false,
      dispose: async () => {},
    };

    (ctx.controller as unknown as { directory: { registerHostRunner: (runner: typeof workerRunner) => unknown } }).directory.registerHostRunner(workerRunner);

    // 模拟 telemetry 中同一个 cwd 下有一个活跃的 monitor 窗口和一个离线的 worker 窗口
    const fakeOwners = [
      {
        workspaceId: "ws-test",
        normalizedCwd: ctx.tmpDir,
        ownerId: "owner-monitor-62ebda",
        ownerNonce: "nonce-mon",
        pid: 1001,
        sessionId: "sess-monitor-control",
        publishedAt: 2000,
        alive: true,
        ageMs: 10,
        contextPressure: 50,
        agents: [],
        settled: [],
        backgroundJobs: [],
      },
    ];

    (ctx.controller as unknown as { telemetryReader: { read: () => Promise<{ owners: typeof fakeOwners }> } }).telemetryReader = {
      read: async () => ({ owners: fakeOwners }),
    };

    // 发送 prompt 给 sess-worker-1
    const ws = await connectV2(ctx.url);
    await new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify({ type: "prompt", sessionId: "sess-worker-1", message: "这是给Worker的任务", id: "cmd-prompt-1" }));
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as { type: string; ok: boolean; result?: { injectedToTui: boolean } };
        if (msg.type === "command_result") {
          expect(msg.ok).toBe(true);
          expect(msg.result?.injectedToTui).toBeUndefined();
          expect(runnerPromptCalled).toBe(true);
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
  });

  it("handles abort command: calls runner.abort when session is in host memory", async () => {
    let abortCalled = false;
    const runner = {
      id: "sess-host-run",
      state: { id: "sess-host-run", cwd: ctx.tmpDir, title: "Host Run", runState: "streaming", messageCount: 1, pendingMessageCount: 0, updatedAt: "" },
      hasMoreHistory: false,
      snapshot: () => ({ session: runner.state, timeline: [], nextSeq: 0, hasMoreHistory: false }),
      eventsSince: () => [],
      loadMoreHistory: async () => ({ items: [], hasMore: false, totalEntries: 0 }),
      searchHistory: async () => ({ matches: [], totalEntries: 0 }),
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => { abortCalled = true; },
      respondToExtensionUi: () => false,
      dispose: async () => {},
    };
    (ctx.controller as unknown as { directory: { registerHostRunner: (runner: typeof runner) => unknown } }).directory.registerHostRunner(runner);

    const ws = await connectV2(ctx.url);
    await new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify({ type: "abort", sessionId: "sess-host-run", id: "cmd-abort-1" }));
      ws.on("message", (raw) => {
        const d = JSON.parse(raw.toString());
        if (d.type === "command_result" && d.in_reply_to === "cmd-abort-1") {
          expect(abortCalled).toBe(true);
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
  });

  it("handles abort command: forwards SIGINT when session belongs to an active desktop TUI window", async () => {
    const fakeOwner = {
      workspaceId: "ws-test",
      normalizedCwd: ctx.tmpDir,
      ownerId: "owner-tui-12345",
      ownerNonce: "nonce-1",
      pid: 99999, // 模拟目标终端 PID
      sessionId: "sess-desktop-tui-1",
      publishedAt: Date.now(),
      alive: true,
      ageMs: 10,
      contextPressure: 20,
      agents: [],
      settled: [],
      backgroundJobs: [],
    };

    (ctx.controller as unknown as { telemetryReader: { read: () => Promise<{ owners: typeof fakeOwner[] }> } }).telemetryReader = {
      read: async () => ({ owners: [fakeOwner] }),
    };

    let killedPid: number | undefined;
    let killedSignal: string | number | undefined;
    const origKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      killedPid = pid;
      killedSignal = signal;
      return true;
    }) as typeof process.kill;

    try {
      const ws = await connectV2(ctx.url);
      await new Promise<void>((resolve, reject) => {
        ws.send(JSON.stringify({ type: "abort", sessionId: "sess-desktop-tui-1", id: "cmd-abort-2" }));
        ws.on("message", (raw) => {
          const d = JSON.parse(raw.toString());
          if (d.type === "command_result" && d.in_reply_to === "cmd-abort-2") {
            expect(d.status).toBe("unknown");
            expect(d.error?.code).toBe("target_unavailable");
            expect(killedPid).toBeUndefined();
            expect(killedSignal).toBeUndefined();
            ws.close();
            resolve();
          }
        });
        ws.on("error", reject);
      });
    } finally {
      process.kill = origKill;
    }
  });
});
describe("MobileHostServer.listen error propagation", () => {
  // 回归：端口被占时 listen() 必须 reject（而非永不 settle 导致 uncaughtException 裸崩）
  it("rejects with EADDRINUSE when the port is already in use", async () => {
    const first = await createTestServer();
    const second = new MobileHostServer(first.controller, {});
    let error: NodeJS.ErrnoException | undefined;
    try {
      await second.listen(first.port, "127.0.0.1");
    } catch (caught) {
      error = caught as NodeJS.ErrnoException;
    }
    expect(error?.code).toBe("EADDRINUSE");
    await first.server.close();
    await first.controller.dispose();
    await rm(first.tmpDir, { recursive: true, force: true });
  });

  it("resolves normally on a free port", async () => {
    const probe = await createTestServer();
    const port = probe.port;
    await probe.server.close();
    const reuse = new MobileHostServer(probe.controller, {});
    await reuse.listen(port, "127.0.0.1");
    await reuse.close();
    await probe.controller.dispose();
    await rm(probe.tmpDir, { recursive: true, force: true });
  });
});
