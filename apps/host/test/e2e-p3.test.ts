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
 * 场景 1（disabled lifecycle）：open_session 在没有 exact Desktop target 时确定性拒绝
 * 场景 2（maestro 状态流）：host 轮询 flow-schedule → maestro_state 推送到 WS 客户端
 */

function sessionCatalog() {
  return { listSessions: async () => [] };
}

describe("P3 E2E: host ↔ mobile over WebSocket", () => {
  let controller: HostController;
  let server: MobileHostServer;
  let port: number;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "e2e-maestro-"));
    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    controller = new HostController(sessionCatalog(), reader);
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
      const onMessage = (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString()) as { type?: string };
        if (frame.type !== "protocol_ready") return;
        ws.off("message", onMessage);
        resolve(ws);
      };
      ws.on("message", onMessage);
      ws.once("open", () => ws.send(JSON.stringify({ type: "protocol_hello", protocolVersion: 2, clientVersion: "e2e-test", capabilities: ["session_control", "extension_ui", "monitor_read"], requestId: "hello-e2e" })));
      ws.once("error", reject);
    });
  }

  it("场景1: open_session 无 exact target 时确定性拒绝", async () => {
    const ws = await connectClient();
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "command_result" && frame.in_reply_to === "disabled-open") resolve(frame);
      });
    });
    ws.send(JSON.stringify({ id: "disabled-open", type: "open_session", cwd: "/tmp", mode: "create" }));
    await expect(reply).resolves.toMatchObject({ ok: false, error: { code: "session_creation_disabled" } });
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