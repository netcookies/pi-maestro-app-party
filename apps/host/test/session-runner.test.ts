import { describe, expect, it } from "vitest";
import { SdkSessionRunner } from "../src/session-runner.js";
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