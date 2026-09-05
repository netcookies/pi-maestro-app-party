import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MobileHostServer } from "../src/server/mobile-host-server.js";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { SessionRunner } from "../src/types.js";

/** steer_window 接管语义测试：已打开会话直接 steer；未打开 → open_session 接管后 steer */
function makeRunner(sessionId: string) {
  const steered: string[] = [];
  const runner: SessionRunner = {
    id: sessionId,
    state: {
      id: sessionId, cwd: "/tmp", title: sessionId, runState: "idle",
      messageCount: 0, pendingMessageCount: 0, updatedAt: "",
    },
    hasMoreHistory: false,
    snapshot: () => ({ session: runner.state, timeline: [], nextSeq: 0, hasMoreHistory: false }),
    eventsSince: () => [],
    loadMoreHistory: async () => ({ items: [], hasMore: false, totalEntries: 0 }),
    searchHistory: async () => ({ matches: [], totalEntries: 0 }),
    prompt: async () => {},
    steer: async (message: string) => { steered.push(message); },
    followUp: async () => {},
    abort: async () => {},
    respondToExtensionUi: () => false,
    dispose: async () => {},
  };
  return { runner, steered };
}

describe("steer_window", () => {
  let tmpDir: string;
  let controller: HostController;
  let server: MobileHostServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `steer-window-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    controller = new HostController(
      { createRuntime: async () => { throw new Error("no runtime in test"); }, listSessions: async () => [] },
      new MaestroStateReader({ projectRoot: tmpDir }),
    );
    server = new MobileHostServer(controller, {});
    await server.listen(0, "127.0.0.1");
    port = server.address().port;
  });

  afterEach(async () => {
    await server.close();
    await controller.dispose();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function withWs(fn: (ws: WebSocket) => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("open", () => void fn(ws).then(resolve, reject));
      ws.on("error", reject);
    });
  }

  function request(ws: WebSocket, command: unknown): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> {
    return new Promise((resolve) => {
      ws.on("message", function handler(data) {
        const msg = JSON.parse(data.toString()) as { type: string; ok: boolean; result?: unknown; error?: { code: string } };
        if (msg.type === "command_result") {
          ws.off("message", handler);
          resolve(msg);
        }
      });
      ws.send(JSON.stringify(command));
    });
  }

  it("steers directly when the window session is already open (tookOver=false)", async () => {
    const { runner, steered } = makeRunner("sess-open-1");
    // 直接注册到 controller.sessions（绕过 openSession，避免依赖 runtime）
    (controller as unknown as { sessions: Map<string, SessionRunner> }).sessions.set("sess-open-1", runner);

    await withWs(async (ws) => {
      const reply = await request(ws, { type: "steer_window", endpointId: "sess-open-1", cwd: "/tmp/proj", message: "先跑测试" });
      expect(reply.ok).toBe(true);
      expect(reply.result).toEqual({ ok: true, sessionId: "sess-open-1", tookOver: false });
      expect(steered).toEqual(["先跑测试"]);
    });
  });

  it("reports error (not throw) when window is unknown and openSession fails", async () => {
    await withWs(async (ws) => {
      const reply = await request(ws, { type: "steer_window", endpointId: "sess-unknown", cwd: tmpDir, message: "hello" });
      expect(reply.ok).toBe(true); // ack 包裹（错误在 result.ok=false 里，不抛协议错误）
      const result = reply.result as { ok: boolean; tookOver: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(result.tookOver).toBe(false);
      expect(typeof result.error).toBe("string");
    });
  });
});
