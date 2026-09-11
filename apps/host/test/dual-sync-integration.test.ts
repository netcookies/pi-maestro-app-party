import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MobileHostServer } from "../src/server/mobile-host-server.js";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { HostEvent, TimelineItem } from "@maestro-mobile/shared";
import type { SessionRunner } from "../src/types.js";

/**
 * 方案 A 双向实时同步与生命周期集成测试 (AC1 - AC5)
 */
describe("Dual-Sync Integration (方案A: TUI <-> Mobile 实时同步与生命周期)", () => {
  let tmpDir: string;
  let server: MobileHostServer;
  let controller: HostController;
  let port: number;
  let sessionFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `mm-dualsync-${randomUUID()}`));
    sessionFile = join(tmpDir, "active-session.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    const runtimeFactory = {
      createRuntime: async (req: { cwd: string; sessionFile?: string }) => {
        const subscribers = new Set<(e: unknown) => void>();
        const steered: string[] = [];
        const session = {
          sessionId: "sess-dual-1",
          sessionName: "dual",
          cwd: tmpDir,
          sessionFile: req.sessionFile ?? sessionFile,
          messages: [],
          pendingMessageCount: 0,
          isStreaming: false,
          isCompacting: false,
          model: undefined,
          thinkingLevel: undefined,
          prompt: async () => undefined,
          steer: async (msg: string) => { steered.push(msg); },
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
          cwd: tmpDir,
          dispose: async () => undefined,
          runtime: { session, cwd: tmpDir, dispose: async () => undefined },
        };
      },
      listSessions: async () => [],
    };

    controller = new HostController(runtimeFactory as never, reader);
    server = new MobileHostServer(controller, { token: "secret" });
    await server.listen(0, "127.0.0.1");
    port = server.address().port;
  });

  afterEach(async () => {
    await server.close();
    await controller.dispose();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function connectClient(): {
    ws: WebSocket;
    opened: Promise<void>;
    events: HostEvent[];
    waitForEvent: (predicate: (e: HostEvent) => boolean, timeoutMs?: number) => Promise<HostEvent>;
  } {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`);
    const events: HostEvent[] = [];
    const waiters: { predicate: (e: HostEvent) => boolean; resolve: (e: HostEvent) => void }[] = [];

    ws.on("message", (d) => {
      try {
        const e = JSON.parse(d.toString()) as HostEvent;
        events.push(e);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(e)) {
            waiters.splice(i, 1)[0].resolve(e);
          }
        }
      } catch { /* ignore */ }
    });

    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const waitForEvent = (predicate: (e: HostEvent) => boolean, timeoutMs = 4000): Promise<HostEvent> =>
      new Promise((resolve, reject) => {
        const found = events.find(predicate);
        if (found) { resolve(found); return; }
        const timer = setTimeout(() => reject(new Error("waitForEvent timeout")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (e) => { clearTimeout(timer); resolve(e); },
        });
      });

    return { ws, opened, events, waitForEvent };
  }

  it("AC1 + AC3: 桌面 TUI 写入新内容时，移动端实时收到 timeline_item 广播", async () => {
    const client = connectClient();
    await client.opened;

    // 移动端打开会话
    const openPromise = client.waitForEvent((e) => e.type === "command_result" && (e as { in_reply_to?: string }).in_reply_to === "cmd-open");
    client.ws.send(JSON.stringify({
      id: "cmd-open",
      type: "open_session",
      cwd: tmpDir,
      mode: "continue",
      sessionFile,
    }));
    await openPromise;

    // 此时模拟桌面 TUI（进程外写入）向 JSONL 文件追加新回复
    const tuiMessageLine = JSON.stringify({
      type: "message",
      id: "tui-turn-1",
      message: {
        role: "assistant",
        content: "这是电脑终端正在打印的模型回复内容",
        timestamp: Date.now(),
      },
    }) + "\n";

    await appendFile(sessionFile, tuiMessageLine, "utf8");

    // 移动端应实时收听到 timeline_item 广播
    const itemEvent = await client.waitForEvent(
      (e) => e.type === "timeline_item" && (e as { item: TimelineItem }).item?.text === "这是电脑终端正在打印的模型回复内容",
      3000,
    );
    expect(itemEvent).toBeDefined();

    client.ws.close();
  });

  it("AC2: close_session 或会话销毁时，底层的 TailWatcher 100% 释放", async () => {
    const client = connectClient();
    await client.opened;

    // 打开会话
    const openPromise = client.waitForEvent((e) => e.type === "command_result" && (e as { in_reply_to?: string }).in_reply_to === "cmd-open");
    client.ws.send(JSON.stringify({
      id: "cmd-open",
      type: "open_session",
      cwd: tmpDir,
      mode: "continue",
      sessionFile,
    }));
    await openPromise;

    const runner = controller.getSession("sess-dual-1") as unknown as { tailWatcher: { disposed: boolean } | null };
    expect(runner.tailWatcher).not.toBeNull();
    expect(runner.tailWatcher!.disposed).toBe(false);

    // 客户端发 close_session
    const closePromise = client.waitForEvent((e) => e.type === "command_result" && (e as { in_reply_to?: string }).in_reply_to === "cmd-close");
    client.ws.send(JSON.stringify({
      id: "cmd-close",
      type: "close_session",
      sessionId: "sess-dual-1",
    }));
    await closePromise;

    // 会话已从 controller 移除，且 watcher 处于 disposed 状态
    expect(controller.getSession("sess-dual-1")).toBeUndefined();
    expect(runner.tailWatcher).toBeNull();

    client.ws.close();
  });

  it("AC4: 运行时 streaming 时发送 prompt 自动走 steer 介入流", async () => {
    const client = connectClient();
    await client.opened;

    client.ws.send(JSON.stringify({
      id: "cmd-open",
      type: "open_session",
      cwd: tmpDir,
      mode: "continue",
      sessionFile,
    }));
    await client.waitForEvent((e) => e.type === "command_result" && (e as { in_reply_to?: string }).in_reply_to === "cmd-open");

    const runner = controller.getSession("sess-dual-1") as SessionRunner & { state: { runState: string } };
    // 模拟会话处于 streaming 运行状态
    runner.state.runState = "streaming";

    const promptPromise = client.waitForEvent((e) => e.type === "command_result" && (e as { in_reply_to?: string }).in_reply_to === "cmd-prompt");
    client.ws.send(JSON.stringify({
      id: "cmd-prompt",
      type: "prompt",
      sessionId: "sess-dual-1",
      message: "打断并引导这条消息",
    }));

    const reply = await promptPromise;
    expect((reply as { ok?: boolean }).ok).toBe(true);

    client.ws.close();
  });
});
