import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { replayTailFromJsonl, replayPageFromJsonl } from "../src/jsonl-pager.js";
import { invalidateIndex } from "../src/jsonl-index.js";

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
    invalidateIndex(path);
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

  it("retains image references and read image calls in paged history", async () => {
    await writeLines([
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "请看图" },
            { type: "image", data: "AQID", mimeType: "image/png" },
          ],
          timestamp: 1000,
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/pi-clipboard-paged.png" } }],
          timestamp: 1001,
        },
      }),
    ]);

    const page = await replayTailFromJsonl(path, 10);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].images).toHaveLength(1);
    expect(page.items[0].text).toBe("请看图");
    expect(page.items[1]).toMatchObject({ kind: "tool", toolName: "read", text: "/tmp/pi-clipboard-paged.png" });
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

  it("pagination cursor counts messages (not rendered items) — duplicate toolResult preserved hasMore", async () => {
    // RV-003 回归：150 user + 50 duplicate toolResult；tail(80) 必须仍 hasMore=true
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) lines.push(msg("user", `u${i}`, 1000 + i));
    for (let i = 0; i < 50; i++) {
      lines.push(msg("toolResult", `dup${i}`, 2000 + i, { toolCallId: "same", toolName: "bash" }));
    }
    await writeLines(lines);

    const tail = await replayTailFromJsonl(path, 80);
    // cursor 按 message 数 = 80（tail 返回 80 条 message 窗口，最先的 30 条 toolResult 被去重为 0 item）
    expect(tail.cursor).toBe(80);
    // 窗口含 50 条 dup（仅 1 条产生 item——最后一条）+ 30 条 user → items = 31
    expect(tail.items.length).toBe(31);
    // 仍有更早的 120 条 user 未返回 → hasMore 必须 true
    expect(tail.hasMore).toBe(true);
    // 末条是去重后保留的 toolResult（窗口内第一条 dup0 被保留；dup1-49 去重为 null）
    expect(tail.items[tail.items.length - 1].text).toBe("dup0");
    // 首条应是 u120（150-30）
    expect(tail.items[0].text).toBe("u120");

    // 翻页到更早：cursor=80 → 返回 [u40, u119] 之类的窗口（40 条 user）
    const page = await replayPageFromJsonl(path, 80, 80);
    expect(page.items.length).toBe(80);
    expect(page.items[0].text).toBe("u40");
    expect(page.hasMore).toBe(true);
  });

  it("H8: indexed page path returns same results as full scan across repeated pages", async () => {
    // 200 条 user：先 tail 50，再连续翻 3 页，索引路径与全量扫描结果必须一致
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(msg("user", `u${i}`));
    await writeLines(lines);

    // 全量扫描基准（先建基准再清缓存，让后续页走索引路径）
    const tail = await replayTailFromJsonl(path, 50);
    expect(tail.items[0].text).toBe("u150");
    let cursor = tail.cursor;
    const collected = tail.items.map((t) => t.text);

    for (let p = 0; p < 3; p++) {
      const page = await replayPageFromJsonl(path, cursor, 50);
      expect(page.items.length).toBe(50);
      collected.push(...page.items.map((t) => t.text));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    // 200 条全部收集完毕（倒序分页: tail 末窗口 + 3 页向前）
    expect(collected.length).toBe(200);
    // 文件序分界点: 各窗口内保持文件序
    expect(collected[0]).toBe("u150");
    expect(collected[49]).toBe("u199");
    expect(collected[50]).toBe("u100");
    expect(collected[150]).toBe("u0");
    expect(collected[199]).toBe("u49");
    // 连续页无重叠/遗漏：唯一
    expect(new Set(collected).size).toBe(200);
  });

  it("H8: index invalidation on append — new pages reflect new file", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(msg("user", `u${i}`));
    await writeLines(lines);
    const first = await replayTailFromJsonl(path, 10);
    expect(first.totalEntries).toBe(30);

    // Pi 追加写入 → size/mtime 变化 → 索引自动重建
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, [msg("user", "u30"), msg("user", "u31")].join("\n") + "\n");
    const second = await replayTailFromJsonl(path, 10);
    expect(second.totalEntries).toBe(32);
    expect(second.items[second.items.length - 1].text).toBe("u31");
  });
});

// 泛化发现回归：流式扫描的残行上限（与 usage-reader 同族）。
// MAX_LINE_BYTES 只拦「完整行」，修复前 buf 在遇到换行前无上限累积，
// 畸形无换行文件会把它堆到接近文件大小。
describe("jsonl-pager oversized-line carry bound", () => {
  const MB = 1024 * 1024;

  it("单条 4.2MB 无换行巨行：整行丢弃且后续正常行仍解析（scanWindow）", async () => {
    const dir2 = join(tmpdir(), `jsonl-huge-${randomUUID()}`);
    await mkdir(dir2, { recursive: true });
    const p = join(dir2, "s.jsonl");
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(" ")); });
    try {
      const header = JSON.stringify({ type: "session", id: "s", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/p", parentSession: null });
      const huge = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "A".repeat(Math.ceil(4.2 * MB)) }], timestamp: 1 } });
      const tail = msg("user", "after-marker");
      expect(huge.length).toBeGreaterThan(4 * MB); // 确实越过 MAX_LINE_BYTES
      await writeFile(p, `${header}\n${huge}\n${tail}\n`);
      invalidateIndex(p);

      const page = await replayTailFromJsonl(p, 100);
      // 巨行被整行丢弃：不计入 totalEntries，也不进 ring（无占位 null）
      expect(page.totalEntries).toBe(1);
      // 关键：截断不能污染后续解析（skipToNewline 只丢该行的尾巴）
      expect(page.items.map((i) => i.text).join("|")).toContain("after-marker");
      // 区分点：旧实现同样会丢弃「已完整读完」的超限行（handleLine 早先就有长度检查），
      // 所以 totalEntries/items 在新旧代码上相同 —— 只有峰值内存不同（非确定性，不能断言）。
      // 唯一稳定的可观测差异是这条告警（与 usage-reader 同口径）：旧实现不计数、不告警。
      expect(warns.some((w) => w.includes("跳过 1 行")), `warns=${JSON.stringify(warns)}`).toBe(true);
    } finally {
      spy.mockRestore();
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("searchInJsonl 同样受残行上限保护，且不丢后续匹配", async () => {
    const dir2 = join(tmpdir(), `jsonl-huge-s-${randomUUID()}`);
    await mkdir(dir2, { recursive: true });
    const p = join(dir2, "s.jsonl");
    try {
      const header = JSON.stringify({ type: "session", id: "s", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/p", parentSession: null });
      const huge = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "B".repeat(Math.ceil(4.2 * MB)) }], timestamp: 1 } });
      await writeFile(p, `${header}\n${huge}\n${msg("user", "needle-after")}\n`);
      const { searchInJsonl } = await import("../src/jsonl-pager.js");
      const r = await searchInJsonl(p, "needle-after", 50);
      // totalEntries 只计 "type":"message" 行（header 不算）。修复前 searchInJsonl 连单行上限都没有，
      // 巨行会被计入→2；修复后整行丢弃→1。这个差异就是本用例的区分点。
      expect(r.totalEntries).toBe(1);
      expect(r.matches.length).toBe(1);
      expect(r.matches[0].text).toContain("needle-after");
      expect(r.matches[0].index).toBe(0); // 索引不受丢弃行影响地重新连续
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
