import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TIMELINE_ITEMS, SdkSessionRunner } from "../src/session-runner.js";
import type { HostEvent, TimelineItem } from "@maestro-mobile/shared";

/** 构造带历史消息的 fake session */
function makeSessionWithHistory(messages: unknown[]) {
  const subscribers = new Set<(e: unknown) => void>();
  const session = {
    sessionId: "sess-hist",
    sessionName: "hist",
    cwd: "/tmp",
    sessionFile: "/tmp/x.jsonl",
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
  };
}

describe("SdkSessionRunner history replay", () => {
  it("replays user and assistant messages into timeline on open", async () => {
    const runtime = makeSessionWithHistory([
      { role: "user", content: "你好", timestamp: 1756800000000 },
      { role: "assistant", content: "你好！有什么可以帮你？", timestamp: 1756800100000 },
      { role: "user", content: "帮我看看代码", timestamp: 1756800200000 },
    ]);

    let timeline: TimelineItem[] = [];
    const runner = await SdkSessionRunner.open(
      { createRuntime: async () => runtime.runtime, listSessions: async () => [] },
      { cwd: "/tmp", mode: "create", sessionFile: "/tmp/x.jsonl" },
      (event: HostEvent) => {
        if (event.type === "timeline_item") timeline.push(event.item);
      },
    );

    // 历史回放会 emit timeline_item
    const snapshot = runner.snapshot();
    // snapshot 的 timeline 应包含回放项
    expect(snapshot.timeline.length).toBeGreaterThanOrEqual(3);
    const kinds = snapshot.timeline.map((t) => t.kind);
    expect(kinds.filter((k) => k === "user").length).toBe(2);
    expect(kinds.filter((k) => k === "assistant").length).toBe(1);
    expect(snapshot.timeline[0].text).toBe("你好");
    expect(snapshot.timeline[1].text).toBe("你好！有什么可以帮你？");

    await runner.dispose();
  });

  it("handles empty history gracefully", async () => {
    const runtime = makeSessionWithHistory([]);
    const runner = await SdkSessionRunner.open(
      { createRuntime: async () => runtime.runtime, listSessions: async () => [] },
      { cwd: "/tmp", mode: "create" },
      () => {},
    );
    expect(runner.snapshot().timeline).toEqual([]);
    await runner.dispose();
  });

  it("extracts text from content block arrays", async () => {
    const runtime = makeSessionWithHistory([
      {
        role: "assistant",
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
        timestamp: 1756800000000,
      },
    ]);
    const runner = await SdkSessionRunner.open(
      { createRuntime: async () => runtime.runtime, listSessions: async () => [] },
      { cwd: "/tmp", mode: "create" },
      () => {},
    );
    const items = runner.snapshot().timeline;
    expect(items[0].text).toContain("第一段");
    expect(items[0].text).toContain("第二段");
    await runner.dispose();
  });

  it("replays toolResult messages as tool timeline items", async () => {
    const runtime = makeSessionWithHistory([
      {
        role: "user",
        content: "跑一下 ls",
        timestamp: 1756800000000,
      },
      {
        role: "toolResult",
        toolCallId: "call_123",
        toolName: "bash",
        content: [{ type: "text", text: "total 0\ndrwxr-xr-x 3 isulewli staff 96 .pi\n" }],
        isError: false,
        timestamp: 1756800001000,
      },
      {
        role: "assistant",
        content: "结果如上",
        timestamp: 1756800002000,
      },
    ]);
    const runner = await SdkSessionRunner.open(
      { createRuntime: async () => runtime.runtime, listSessions: async () => [] },
      { cwd: "/tmp", mode: "create" },
      () => {},
    );
    const items = runner.snapshot().timeline;
    expect(items).toHaveLength(3);

    const tool = items[1];
    expect(tool.kind).toBe("tool");
    expect(tool.toolName).toBe("bash");
    expect(tool.text).toContain("drwxr-xr-x");
    await runner.dispose();
  });

  it("deduplicates toolResult by toolCallId", async () => {
    const runtime = makeSessionWithHistory([
      {
        role: "toolResult",
        toolCallId: "call_same",
        toolName: "read",
        content: [{ type: "text", text: "内容A" }],
        timestamp: 1756800000000,
      },
      {
        role: "toolResult",
        toolCallId: "call_same",
        toolName: "read",
        content: [{ type: "text", text: "内容B" }],
        timestamp: 1756800001000,
      },
    ]);
    const runner = await SdkSessionRunner.open(
      { createRuntime: async () => runtime.runtime, listSessions: async () => [] },
      { cwd: "/tmp", mode: "create" },
      () => {},
    );
    const items = runner.snapshot().timeline;
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("内容A");
    await runner.dispose();
  });
});

describe("SdkSessionRunner timeline history cap", () => {
  // 实测（load 36）：12000 行写盘 + ~150 页翻页 = 1404ms。默认 5s 在高负载机器上无余量，
  // 会报成假失败（同文件另一用例实测 load 155 时超 5s、load 36 时 <1.5s）。
  // 两条重 IO 用例自带循环守卫（pages<500 / guard<200），真死循环由断言暴露，超时只是机器慢的兜底。
  const TIMELINE_CAP_TEST_TIMEOUT = 30_000;

  /** 写一个含 n 条 message 的真实 jsonl，驱动 loadMoreHistory 向前翻页 */
  async function makeJsonl(path: string, n: number): Promise<void> {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(JSON.stringify({
        type: "message", id: `m${i}`,
        message: { role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}`, timestamp: 1756800000000 + i * 1000 },
      }));
    }
    await writeFile(path, lines.join("\n"));
  }

  async function openWithFile(totalMessages: number) {
    const dir = await mkdtemp(join(tmpdir(), "mm-timeline-cap-"));
    const file = join(dir, "sess.jsonl");
    await makeJsonl(file, totalMessages);
    const runtime = makeSessionWithHistory([]);
    runtime.session.sessionFile = file;
    const runner = await SdkSessionRunner.open(
      { createRuntime: async () => runtime.runtime, listSessions: async () => [] },
      { cwd: "/tmp", mode: "create", sessionFile: file },
      () => undefined,
    );
    return { dir, runner };
  }

  it("stops paging once the cap is reached, without dropping delivered items", async () => {
    const { dir, runner } = await openWithFile(MAX_TIMELINE_ITEMS * 3);
    let delivered = runner.snapshot().timeline.length;
    let pages = 0;
    let last: { items: TimelineItem[]; hasMore: boolean } = { items: [], hasMore: true };

    // 持续翻页直到 hasMore=false，模拟客户端自动加载不断叠加
    while (last.hasMore && pages < 500) {
      last = await runner.loadMoreHistory(80);
      pages++;
      delivered += last.items.length;
      const now = runner.snapshot().timeline.length;
      // 已交付条目永不丢失：驻留长度只能等于「已交付总数」或被上限截断
      expect(now).toBeGreaterThanOrEqual(Math.min(delivered, MAX_TIMELINE_ITEMS));
    }

    const final = runner.snapshot().timeline.length;
    expect(final).toBeLessThanOrEqual(MAX_TIMELINE_ITEMS);
    expect(last.hasMore).toBe(false);
    // 到顶即停：驻留长度恰好等于交付总数（未被裁剪）
    expect(final).toBe(delivered);
    // 保留最新尾部内容
    expect(runner.snapshot().timeline[final - 1].text).toContain(`msg-${MAX_TIMELINE_ITEMS * 3 - 1}`);
    await runner.dispose();
    await rm(dir, { recursive: true, force: true });
  }, TIMELINE_CAP_TEST_TIMEOUT);

  it("clamps an oversized page request to the remaining room", async () => {
    const { dir, runner } = await openWithFile(MAX_TIMELINE_ITEMS + 1000);
    // 先把 timeline 填到接近上限：逐页翻到 room < 一次大请求
    let guard = 0;
    while (runner.hasMoreHistory && guard++ < 200) {
      const snapshot = runner.snapshot().timeline;
      if (snapshot.length > MAX_TIMELINE_ITEMS - 20) break;
      await runner.loadMoreHistory(80);
    }
    const before = runner.snapshot().timeline.length;
    const big = await runner.loadMoreHistory(MAX_TIMELINE_ITEMS);
    const after = runner.snapshot().timeline.length;
    expect(after).toBeLessThanOrEqual(MAX_TIMELINE_ITEMS);
    expect(after).toBeGreaterThanOrEqual(before);
    await runner.dispose();
    await rm(dir, { recursive: true, force: true });
  }, TIMELINE_CAP_TEST_TIMEOUT);

  it("keeps paging while below the cap", async () => {
    const { dir, runner } = await openWithFile(MAX_TIMELINE_ITEMS + 400);
    const before = runner.snapshot().timeline.length;
    const page = await runner.loadMoreHistory(80);
    expect(page.items.length).toBeGreaterThan(0);
    expect(runner.snapshot().timeline.length).toBe(before + page.items.length);
    expect(runner.hasMoreHistory).toBe(true);
    await runner.dispose();
    await rm(dir, { recursive: true, force: true });
  });
});
