import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MobileHostServer } from "../src/server/mobile-host-server.js";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

function protocolHello() {
  return JSON.stringify({
    type: "protocol_hello",
    protocolVersion: 2,
    clientVersion: "boundary-test",
    capabilities: ["session_control"],
    requestId: `hello-${randomUUID()}`,
  });
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
      const onMessage = (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString()) as { type?: string };
        if (frame.type !== "protocol_ready") return;
        ws.off("message", onMessage);
        void fn(ws).then(resolve, reject);
      };
      ws.on("message", onMessage);
      ws.on("error", reject);
      ws.on("open", () => ws.send(protocolHello()));
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

  it("returns structured unsupported_command for legacy steer_window", async () => {
    await withWs(async (ws) => {
      const reply = await request(ws, { id: "legacy-window", type: "steer_window", endpointId: "sess-open-1", cwd: tmpDir, message: "先跑测试" });
      expect(reply.ok).toBe(false);
      expect((reply as { error?: { code: string } }).error?.code).toBe("unsupported_command");
    });
  });

  it("does not use telemetry, mailbox, or takeover behavior for unknown legacy windows", async () => {
    await withWs(async (ws) => {
      const reply = await request(ws, { id: "legacy-unknown", type: "steer_window", endpointId: "sess-unknown", cwd: tmpDir, message: "hello" });
      expect(reply.ok).toBe(false);
      expect((reply as { error?: { code: string } }).error?.code).toBe("unsupported_command");
    });
  });

  it("rejects legacy takeover attempts without touching session files", async () => {
    await withWs(async (ws) => {
      const reply = await request(ws, { id: "legacy-takeover", type: "steer_window", endpointId: "sess-tui-active", cwd: tmpDir, message: "来自移动端监督" });
      expect(reply.ok).toBe(false);
      expect((reply as { error?: { code: string } }).error?.code).toBe("unsupported_command");
    });
  });

  it("rejects exact-session takeover legacy behavior", async () => {
    await withWs(async (ws) => {
      const reply = await request(ws, { id: "legacy-file", type: "steer_window", endpointId: "sess-matched-file", cwd: tmpDir, message: "精准接管测试" });
      expect(reply.ok).toBe(false);
      expect((reply as { error?: { code: string } }).error?.code).toBe("unsupported_command");
    });
  });
});
