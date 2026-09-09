import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SdkSessionRunner } from "../src/session-runner.js";
import type { HostEvent, TimelineItem } from "@maestro-mobile/shared";

/** 构造带 sessionFile 的 fake runtime（历史回放走真实 jsonl） */
function makeRuntime(sessionFile: string, messages: unknown[] = []) {
  const subscribers = new Set<(e: unknown) => void>();
  const session = {
    sessionId: "sess-concurrent",
    sessionName: "concurrent",
    cwd: "/tmp",
    sessionFile,
    messages,
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
    emit(role: string, content: string, ts: number, extra: Record<string, unknown> = {}) {
      const event = { type: "message_end", message: { role, content, timestamp: ts, ...extra } };
      for (const fn of subscribers) fn(event);
    },
    emitUpdate(role: string, content: string, ts: number) {
      const event = { type: "message_update", message: { role, content, timestamp: ts } };
      for (const fn of subscribers) fn(event);
    },
  };
}

describe("P2-3: loadMoreHistory 并发合并", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `runner-lock-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    path = join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("3 个并发调用共享同一页结果，cursor 只前进一次，无重复历史", async () => {
    // 90 条消息，页大小 80：tail=80（msg-10..89, cursor=80），下一页 = msg-7..9
    const lines = Array.from({ length: 90 }, (_, i) =>
      JSON.stringify({ type: "message", message: { role: "user", content: `msg-${i}`, timestamp: 1756800000000 + i } }),
    );
    await writeFile(path, lines.join("\n") + "\n");

    const runtime = makeRuntime(path);
    const runner = await SdkSessionRunner.open(
      { createRuntime: async () => runtime.runtime, listSessions: async () => [] },
      { cwd: "/tmp", mode: "continue", sessionFile: path },
      () => {},
    );
    expect(runner.snapshot().timeline).toHaveLength(80);

    const [a, b, c] = await Promise.all([
      runner.loadMoreHistory(3),
      runner.loadMoreHistory(3),
      runner.loadMoreHistory(3),
    ]);

    // 三个调用共享同一结果（同一页 msg-7..9）
    expect(a.items.map((i) => i.text)).toEqual(["msg-7", "msg-8", "msg-9"]);
    expect(b.items).toEqual(a.items);
    expect(c.items).toEqual(a.items);

    // timeline 无重复
    const snap = runner.snapshot();
    const ids = snap.timeline.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(snap.timeline).toHaveLength(83); // 80 tail + 1 page

    await runner.dispose();
  });

  it("顺序调用正常翻页（合并不影响串行语义）", async () => {
    const lines = Array.from({ length: 90 }, (_, i) =>
      JSON.stringify({ type: "message", message: { role: "user", content: `msg-${i}`, timestamp: 1756800000000 + i } }),
    );
    await writeFile(path, lines.join("\n") + "\n");

    const runtime = makeRuntime(path);
    const runner = await SdkSessionRunner.open(
      { createRuntime: async () => runtime.runtime, listSessions: async () => [] },
      { cwd: "/tmp", mode: "continue", sessionFile: path },
      () => {},
    );

    const page2 = await runner.loadMoreHistory(3);
    expect(page2.items.map((i) => i.text)).toEqual(["msg-7", "msg-8", "msg-9"]);
    const page3 = await runner.loadMoreHistory(3);
    expect(page3.items.map((i) => i.text)).toEqual(["msg-4", "msg-5", "msg-6"]);
    expect(runner.snapshot().timeline).toHaveLength(86);

    await runner.dispose();
  });
});

describe("P1-1: live 会话 timeline 投影", () => {
  let dir: string;
  let path: string;
  let events: HostEvent[];

  beforeEach(async () => {
    dir = join(tmpdir(), `runner-live-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    path = join(dir, "session.jsonl");
    await writeFile(path, "");
    events = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function openRunner(runtime: ReturnType<typeof makeRuntime>) {
    return SdkSessionRunner.open(
      { createRuntime: async () => runtime.runtime, listSessions: async () => [] },
      { cwd: "/tmp", mode: "continue", sessionFile: path },
      (event: HostEvent) => events.push(event),
    );
  }

  it("message_end 将 assistant 回复投影为 timeline_item（upsert 语义）", async () => {
    const runtime = makeRuntime(path);
    const runner = await openRunner(runtime);

    // 同一消息：两次 update（不同内容但同 timestamp）+ 一次 end
    runtime.emitUpdate("assistant", "你好", 1756800100000);
    runtime.emitUpdate("assistant", "你好，世界", 1756800100000);
    runtime.emit("assistant", "你好，世界！", 1756800100000);

    const items = events.filter((e) => e.type === "timeline_item").map((e) => (e as { item: TimelineItem }).item);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("assistant");
    expect(items[0].text).toBe("你好，世界！");

    // snapshot 与广播一致
    const snap = runner.snapshot();
    expect(snap.timeline).toHaveLength(1);
    expect(snap.timeline[0].text).toBe("你好，世界！");

    await runner.dispose();
  });

  it("message_update 发出 timeline_delta 且同一 itemId 稳定", async () => {
    const runtime = makeRuntime(path);
    const runner = await openRunner(runtime);

    runtime.emitUpdate("assistant", "第一段", 1756800100000);
    // 间隔 < 节流窗口 → 第二次被节流跳过
    runtime.emitUpdate("assistant", "第一段第二段", 1756800100000);

    const deltas = events.filter((e) => e.type === "timeline_delta") as { itemId: string; delta: string }[];
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    // 所有 delta 用同一 itemId
    expect(new Set(deltas.map((d) => d.itemId)).size).toBe(1);
    expect(deltas[0].delta).toBe("第一段");

    await runner.dispose();
  });

  it("user 消息不重复投影（recordUserMessage 已覆盖）", async () => {
    const runtime = makeRuntime(path);
    const runner = await openRunner(runtime);

    runtime.emit("user", "用户的话", 1756800000000);

    const items = events.filter((e) => e.type === "timeline_item").map((e) => (e as { item: TimelineItem }).item);
    expect(items).toHaveLength(0);

    await runner.dispose();
  });

  it("raw_event 不广播用户图片 base64", async () => {
    const runtime = makeRuntime(path);
    const runner = await openRunner(runtime);

    runtime.emit("user", "", 1756800000000, {
      content: [{ type: "image", data: "AQID-secret-base64", mimeType: "image/png" }],
    });

    const raw = events.find((event) => event.type === "raw_event");
    expect(raw).toBeDefined();
    expect(JSON.stringify(raw)).not.toContain("AQID-secret-base64");
    expect(JSON.stringify(raw)).toContain("[image data omitted]");

    await runner.dispose();
  });

  it("toolResult 投影为 tool 条目且带 toolCallId", async () => {
    const runtime = makeRuntime(path);
    const runner = await openRunner(runtime);

    runtime.emit("toolResult", "命令输出", 1756800100000, { toolCallId: "call_1", toolName: "bash", isError: false });

    const items = events.filter((e) => e.type === "timeline_item").map((e) => (e as { item: TimelineItem }).item);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("tool");
    expect(items[0].toolCallId).toBe("call_1");
    expect(items[0].toolName).toBe("bash");

    await runner.dispose();
  });

  it("message_end 提取无文本的 read 图片工具调用", async () => {
    const runtime = makeRuntime(path);
    const runner = await openRunner(runtime);

    runtime.emit("assistant", "", 1756800100000, {
      content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/pi-clipboard-live.png" } }],
    });

    const items = events.filter((e) => e.type === "timeline_item").map((e) => (e as { item: TimelineItem }).item);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", toolName: "read", text: "/tmp/pi-clipboard-live.png" });

    await runner.dispose();
  });

  it("同一条消息 end 后再次 end（同 key）走替换而非追加", async () => {
    const runtime = makeRuntime(path);
    const runner = await openRunner(runtime);

    runtime.emit("assistant", "旧文本", 1756800100000);
    runtime.emit("assistant", "新文本", 1756800100000);

    const snap = runner.snapshot();
    expect(snap.timeline).toHaveLength(1);
    expect(snap.timeline[0].text).toBe("新文本");

    await runner.dispose();
  });
});
