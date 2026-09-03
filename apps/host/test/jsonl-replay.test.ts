import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { replayFromJsonl } from "../src/jsonl-replay.js";

describe("replayFromJsonl", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `jsonl-replay-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replays full history from a real-format jsonl file", async () => {
    const path = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp", timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ type: "message", id: "1", message: { role: "user", content: "你好", timestamp: 1756800000000 } }),
      JSON.stringify({ type: "message", id: "2", message: { role: "assistant", content: "你好！", timestamp: 1756800001000 } }),
      JSON.stringify({
        type: "message", id: "3",
        message: {
          role: "toolResult", toolCallId: "call_1", toolName: "bash",
          content: [{ type: "text", text: "total 0\ndrwxr-xr-x 3 .pi\n" }],
          isError: false, timestamp: 1756800002000,
        },
      }),
      JSON.stringify({
        type: "message", id: "4",
        message: {
          role: "user",
          content: "/tmp/pi-clipboard-abc.png\n\n你看下图片",
          timestamp: 1756800003000,
        },
      }),
      JSON.stringify({ type: "message", id: "5", message: { role: "thinking", content: "想一下", timestamp: 1756800004000 } }),
    ];
    await writeFile(path, lines.join("\n") + "\n");

    const { items, totalEntries } = await replayFromJsonl(path);
    expect(totalEntries).toBe(5);
    expect(items).toHaveLength(5);

    // 顺序与原始一致
    expect(items[0].kind).toBe("user");
    expect(items[0].text).toBe("你好");
    expect(items[1].kind).toBe("assistant");
    expect(items[2].kind).toBe("tool");
    expect(items[2].toolName).toBe("bash");
    expect(items[2].text).toContain("drwxr-xr-x");
    expect(items[3].kind).toBe("user");
    expect(items[3].text).toContain("/tmp/pi-clipboard-abc.png");
    expect(items[4].kind).toBe("thinking");
  });

  it("deduplicates toolResult by toolCallId", async () => {
    const path = join(dir, "dup.jsonl");
    const lines = [
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: "A", timestamp: 1 } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: "B", timestamp: 2 } }),
    ];
    await writeFile(path, lines.join("\n") + "\n");
    const { items } = await replayFromJsonl(path);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("A");
  });

  it("returns empty for missing file", async () => {
    const { items } = await replayFromJsonl(join(dir, "missing.jsonl"));
    expect(items).toEqual([]);
  });

  it("skips non-message entries and corrupt lines", async () => {
    const path = join(dir, "mixed.jsonl");
    const lines = [
      "not json {{",
      JSON.stringify({ type: "model_change", id: "x" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "ok", timestamp: 1 } }),
    ];
    await writeFile(path, lines.join("\n") + "\n");
    const { items, totalEntries } = await replayFromJsonl(path);
    expect(totalEntries).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("ok");
  });

  it("extracts read-image toolCall into image items", async () => {
    const path = join(dir, "readimg.jsonl");
    const lines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "我来看图" },
            {
              type: "toolCall",
              id: "call_1",
              name: "read",
              arguments: { path: "/tmp/pi-clipboard-abc.png" },
            },
          ],
          timestamp: 1756800000000,
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "read image file [image/png]" }],
          timestamp: 1756800001000,
        },
      }),
    ];
    await writeFile(path, lines.join("\n") + "\n");
    const { items } = await replayFromJsonl(path);
    // assistant 文本 + read 图片 tool 项 + toolResult（内容无路径，跳过？不，保留）
    const toolItems = items.filter((t) => t.kind === "tool" && t.toolName === "read");
    expect(toolItems.length).toBeGreaterThan(0);
    expect(toolItems[0].text).toBe("/tmp/pi-clipboard-abc.png");
  });
});