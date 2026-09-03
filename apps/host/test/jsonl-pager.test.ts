import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { replayTailFromJsonl, replayPageFromJsonl } from "../src/jsonl-pager.js";

function msg(role: string, content: string, ts = 1756800000000, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "message",
    message: { role, content, timestamp: ts, ...extra },
  });
}

describe("jsonl-pager", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `jsonl-pager-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    path = join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeLines(lines: string[]) {
    await writeFile(path, lines.join("\n") + "\n");
  }

  it("tail returns last N items in file order", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => msg("user", `msg-${i}`, 1000 + i));
    await writeLines(lines);

    const tail = await replayTailFromJsonl(path, 3);
    expect(tail.items.map((t) => t.text)).toEqual(["msg-7", "msg-8", "msg-9"]);
    expect(tail.hasMore).toBe(true);
    expect(tail.cursor).toBe(3);
    expect(tail.totalEntries).toBe(10);
  });

  it("page returns earlier items after tail", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => msg("user", `msg-${i}`, 1000 + i));
    await writeLines(lines);

    const tail = await replayTailFromJsonl(path, 3); // msg-7,8,9, cursor=3
    expect(tail.items.map((t) => t.text)).toEqual(["msg-7", "msg-8", "msg-9"]);

    const page1 = await replayPageFromJsonl(path, tail.cursor, 3);
    expect(page1.items.map((t) => t.text)).toEqual(["msg-4", "msg-5", "msg-6"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBe(6);

    const page2 = await replayPageFromJsonl(path, page1.cursor, 3);
    expect(page2.items.map((t) => t.text)).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(page2.hasMore).toBe(true); // msg-0 还存在
    expect(page2.cursor).toBe(9);

    const page3 = await replayPageFromJsonl(path, page2.cursor, 3);
    expect(page3.items.map((t) => t.text)).toEqual(["msg-0"]);
    expect(page3.hasMore).toBe(false);
    expect(page3.cursor).toBe(10);
  });

  it("tail smaller than limit returns all", async () => {
    const lines = [msg("user", "a"), msg("assistant", "b")];
    await writeLines(lines);

    const tail = await replayTailFromJsonl(path, 100);
    expect(tail.items.map((t) => t.text)).toEqual(["a", "b"]);
    expect(tail.hasMore).toBe(false);
    expect(tail.cursor).toBe(2);
  });

  it("handles mixed entries (non-message ignored, dedup toolResult)", async () => {
    const lines = [
      JSON.stringify({ type: "session", cwd: "/x" }),
      msg("user", "hi"),
      msg("toolResult", "out1", 1000, { toolCallId: "c1", toolName: "bash" }),
      msg("toolResult", "out2", 1001, { toolCallId: "c1", toolName: "bash" }), // dup
      msg("assistant", "ok"),
    ];
    await writeLines(lines);

    const tail = await replayTailFromJsonl(path, 10);
    expect(tail.items.map((t) => t.text)).toEqual(["hi", "out1", "ok"]);
    expect(tail.hasMore).toBe(false);
    // totalEntries 含 4 条 message（dup 也算 message）
    expect(tail.totalEntries).toBe(4);
  });

  it("returns empty for missing file", async () => {
    const tail = await replayTailFromJsonl(join(dir, "missing.jsonl"), 10);
    expect(tail.items).toEqual([]);
    expect(tail.hasMore).toBe(false);
  });

  it("searchInJsonl finds matching messages with indexes", async () => {
    const { searchInJsonl } = await import("../src/jsonl-pager.js");
    const lines = [
      msg("user", "你好世界"),
      msg("assistant", "这是回复"),
      msg("user", "再问世界好"),
    ];
    await writeLines(lines);

    const r = await searchInJsonl(path, "世界");
    expect(r.totalEntries).toBe(3);
    expect(r.matches).toHaveLength(2);
    expect(r.matches[0].index).toBe(0);
    expect(r.matches[0].kind).toBe("user");
    expect(r.matches[0].text).toContain("你好世界");
    expect(r.matches[1].index).toBe(2);
  });
});