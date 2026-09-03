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
    expect(body.version).toBe("0.1.0");
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

  it("accepts WebSocket connection and receives host_status", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    const first = await new Promise<unknown>((resolve, reject) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
      ws.on("error", reject);
    });
    const msg = first as { type: string };
    expect(msg.type).toBe("host_status");
    ws.close();
  });

  it("broadcasts maestro_state events to websocket clients", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

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
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

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
});