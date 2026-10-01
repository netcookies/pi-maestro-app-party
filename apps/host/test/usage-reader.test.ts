import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseUsageLine,
  readSessionUsage,
  readRecentUsage,
  listSessionFiles,
  resolveSessionFile,
  sessionIdFromPath,
  EMPTY_TOTALS,
} from "../src/usage-reader.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usage-reader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function usageLine(id: string, usage: Record<string, unknown>, type = "message", role = "assistant"): string {
  return JSON.stringify({ type, id, message: { role, usage } });
}

function topLevelUsageLine(id: string, type: "usage" | "compaction" | "branch_summary", usage: Record<string, unknown>): string {
  return JSON.stringify({ type, id, kind: type === "usage" ? "cache_warm" : undefined, usage });
}

describe("parseUsageLine", () => {
  it("parses a message entry with usage", () => {
    const t = parseUsageLine(usageLine("a1", { input: 33582, output: 268, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 33850, cost: { total: 0.0026 } }));
    expect(t.entries).toBe(1);
    expect(t.input).toBe(33582);
    expect(t.output).toBe(268);
    expect(t.totalTokens).toBe(33850);
    expect(t.cost).toBeCloseTo(0.0026);
  });

  it("computes totalTokens from independent fields only", () => {
    const t = parseUsageLine(usageLine("a2", { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7 }));
    expect(t.reasoning).toBe(7);
    expect(t.totalTokens).toBe(155);
  });

  it("accepts assistant and toolResult messages plus top-level usage-bearing entries", () => {
    const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const lines = [
      usageLine("assistant", usage, "message", "assistant"),
      usageLine("tool", usage, "message", "toolResult"),
      topLevelUsageLine("warm", "usage", usage),
      topLevelUsageLine("compact", "compaction", usage),
      topLevelUsageLine("branch", "branch_summary", usage),
    ];
    for (const line of lines) {
      expect(parseUsageLine(line)).toEqual({
        entries: 1, ...usage, reasoning: 0, totalTokens: 10, cost: 0,
      });
    }
  });

  it("does not add reasoning or cacheWrite1h subsets to totalTokens", () => {
    const t = parseUsageLine(usageLine("subset", {
      input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 7, cacheWrite1h: 8,
    }));
    expect(t.reasoning).toBe(7);
    expect(t.cacheWrite).toBe(40);
    expect(t.totalTokens).toBe(100);
  });

  it.each(["user", "system", "custom", "bashExecution", "tool", undefined])("ignores unsupported message role %s", (role) => {
    expect(parseUsageLine(JSON.stringify({
      type: "message", id: "unsupported-role", message: { role, usage: { input: 100 } },
    }))).toEqual(EMPTY_TOTALS);
  });

  it.each(["model_change", "thinking_level_change", "session", "custom", "custom_message", "context_edit", "unknown"])("ignores unsupported entry type %s", (type) => {
    expect(parseUsageLine(JSON.stringify({
      type, id: "unsupported-kind", usage: { input: 100 }, message: { role: "assistant", usage: { input: 100 } },
    }))).toEqual(EMPTY_TOTALS);
  });

  it.each([null, [], [1], "bad", 12, true])("rejects non-record usage %j for every supported shape", (usage) => {
    const entries = [
      { type: "message", message: { role: "assistant", usage } },
      { type: "message", message: { role: "toolResult", usage } },
      { type: "usage", usage }, { type: "compaction", usage }, { type: "branch_summary", usage },
    ];
    for (const entry of entries) expect(parseUsageLine(JSON.stringify(entry))).toEqual(EMPTY_TOTALS);
  });

  it("returns zeros for malformed JSON, malformed records, and missing usage", () => {
    for (const line of ["not json", '{"usage":', "null", "[]", '[{"usage":{"input":1}}]']) {
      expect(parseUsageLine(line)).toEqual(EMPTY_TOTALS);
    }
    for (const message of [null, [], "bad", { role: "assistant" }, { role: "toolResult" }]) {
      expect(parseUsageLine(JSON.stringify({ type: "message", message, usage: { input: 100 } }))).toEqual(EMPTY_TOTALS);
    }
    for (const type of ["usage", "compaction", "branch_summary"]) {
      expect(parseUsageLine(JSON.stringify({ type }))).toEqual(EMPTY_TOTALS);
    }
  });

  it.each(["-1", "1e309", "-1e309", '"10"', "null", "[]", "true"])("sanitizes invalid numeric token and cost value %s", (value) => {
    // 直接写指数触发非有限值检查；JSON.stringify 会把 Infinity/NaN 转为 null。
    const line = `{"type":"message","message":{"role":"assistant","usage":{
      "input":${value},"output":${value},"cacheRead":${value},"cacheWrite":${value},
      "reasoning":${value},"cacheWrite1h":${value},"totalTokens":${value},"cost":{"total":${value}}
    }}}`;
    expect(parseUsageLine(line)).toEqual({ ...EMPTY_TOTALS, entries: 1 });
  });

  it.each([null, [], "bad", { total: "1" }, { total: -1 }])("sanitizes malformed cost record %j", (cost) => {
    const t = parseUsageLine(usageLine("cost", { input: 2, cost }));
    expect(t.cost).toBe(0);
    expect(t.totalTokens).toBe(2);
  });

  it("preserves valid fields while sanitizing malformed fields", () => {
    const t = parseUsageLine(usageLine("mixed", {
      input: 4, output: 20, cacheRead: -1, cacheWrite: "5", reasoning: 7, cost: { total: 0.4 }, totalTokens: 999,
    }));
    expect(t).toEqual({
      entries: 1, input: 4, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 7, totalTokens: 24, cost: 0.4,
    });
  });

  it("preserves finite large values and sanitizes JSON-serialized nonfinite numbers", () => {
    const t = parseUsageLine(usageLine("a3", { input: Number.MAX_VALUE, output: "bad", cacheRead: NaN }));
    expect(t.entries).toBe(1);
    expect(t.input).toBe(Number.MAX_VALUE);
    expect(t.output).toBe(0);
    expect(t.cacheRead).toBe(0);
    expect(t.totalTokens).toBe(Number.MAX_VALUE);
  });
});

describe("readSessionUsage", () => {
  it("aggregates entries and deduplicates by id", async () => {
    const file = join(dir, "s1.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "s1" }),
      usageLine("m1", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
      usageLine("m1", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }), // 流式补写重复
      usageLine("m2", { input: 200, output: 20, cacheRead: 5, cacheWrite: 0, reasoning: 3 }),
      JSON.stringify({ type: "message", id: "m3", message: { role: "user" } }), // 无 usage
    ];
    await writeFile(file, lines.join("\n"));
    const t = await readSessionUsage(file);
    expect(t.entries).toBe(2);
    expect(t.input).toBe(300);
    expect(t.output).toBe(30);
    expect(t.totalTokens).toBe(300 + 30 + 5);
  });

  it("counts all supported usage-bearing kinds and does not poison ids with ignored rows", async () => {
    const file = join(dir, "mixed.jsonl");
    const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
    const lines = [
      JSON.stringify({ type: "custom", id: "late", usage: usage(999) }),
      topLevelUsageLine("late", "usage", usage(7)),
      usageLine("assistant", usage(1), "message", "assistant"),
      usageLine("tool", usage(2), "message", "toolResult"),
      topLevelUsageLine("warm", "usage", usage(3)),
      topLevelUsageLine("compact", "compaction", usage(4)),
      topLevelUsageLine("branch", "branch_summary", usage(5)),
      usageLine("assistant", usage(100), "message", "assistant"),
      JSON.stringify({ type: "context_edit", id: "ignored", usage: usage(500) }),
      usageLine("user", usage(600), "message", "user"),
      topLevelUsageLine("warm", "usage", usage(300)),
      JSON.stringify({ type: "message", id: "invalid-before-valid", message: { role: "assistant", usage: [] } }),
      usageLine("invalid-before-valid", usage(6)),
      "not json",
      JSON.stringify({ type: "custom_message", id: "custom-message", usage: usage(999) }),
    ];
    await writeFile(file, lines.join("\n"));
    const t = await readSessionUsage(file);
    expect(t.entries).toBe(7);
    expect(t.input).toBe(1 + 2 + 3 + 4 + 5 + 6 + 7);
    expect(t.totalTokens).toBe(t.input);
  });

  it("returns zeros for missing file", async () => {
    const t = await readSessionUsage(join(dir, "nope.jsonl"));
    expect(t.entries).toBe(0);
  });
});

describe("readRecentUsage", () => {
  it("filters files by mtime threshold", async () => {
    const { utimes, stat } = await import("node:fs/promises");
    const fresh = join(dir, "fresh.jsonl");
    const stale = join(dir, "stale.jsonl");
    await writeFile(fresh, usageLine("f1", { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }));
    await writeFile(stale, usageLine("s1", { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 }));
    const old = new Date(Date.now() - 10 * 86_400_000);
    await utimes(stale, old, old);

    const r = await readRecentUsage([
      { path: fresh, mtimeMs: (await stat(fresh)).mtimeMs },
      { path: stale, mtimeMs: (await stat(stale)).mtimeMs },
    ], Date.now() - 86_400_000);
    expect(r.files).toBe(1);
    expect(r.totals.input).toBe(10);
  });
});

describe("listSessionFiles / resolveSessionFile", () => {
  it("lists jsonl files under --cwd-- dirs sorted by mtime desc", async () => {
    const cwdDir = join(dir, "--Users-test-proj--");
    await mkdir(cwdDir);
    const a = join(cwdDir, "a.jsonl");
    await writeFile(a, "{}");
    await new Promise((r) => setTimeout(r, 20));
    const b = join(cwdDir, "b.jsonl");
    await writeFile(b, "{}");
    const files = await listSessionFiles(dir);
    expect(files.map((f) => sessionIdFromPath(f.path))).toEqual(["b", "a"]);
  });

  it("resolves sessionId to file path across cwd dirs", async () => {
    const cwdDir = join(dir, "--Users-test-proj--");
    await mkdir(cwdDir);
    await writeFile(join(cwdDir, "session-abc.jsonl"), "{}");
    const found = await resolveSessionFile("session-abc", dir);
    expect(found?.endsWith("session-abc.jsonl")).toBe(true);
    expect(await resolveSessionFile("missing", dir)).toBeUndefined();
  });
});

describe("readSessionUsage streaming", () => {
  // 512KB 分块边界：行被切成多块时，残行必须拼接后再解析。
  // 关键设计：超大行本身必须含 "usage"（否则被 consume 预筛直接 return，污染不会显现），
  // 且填充逐字节变化（全同字节无法区分“读到本行原数据”还是“读到被下一轮 read 覆盖后的脏数据”）。
  it("aggregates correctly across chunk boundaries for large files", async () => {
    const file = join(dir, "big.jsonl");
    const filler = (seed: number): string =>
      Array.from({ length: 600 * 1024 }, (_, i) => String.fromCharCode(97 + ((i + seed) % 26))).join("");
    const bigUsage = (id: string, input: number, seed: number): string => JSON.stringify({
      type: "message", id, blob: filler(seed),
      message: { role: "assistant", usage: { input, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
    });
    const rows = [
      usageLine("m1", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
      bigUsage("m2", 200, 1),                       // 跨多块，且 >512KB
      usageLine("m3", { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
      bigUsage("m4", 400, 7),                       // 再次跳块，末尾无换行
    ];
    await writeFile(file, rows.join("\n"));

    const t = await readSessionUsage(file);
    expect(t.entries).toBe(4);
    expect(t.input).toBe(100 + 200 + 7 + 400);
    expect(t.output).toBe(10 + 3 + 3 + 3);
    expect(t.totalTokens).toBe(t.input + t.output);
  });

  it("handles files whose last line has no trailing newline", async () => {
    const file = join(dir, "noeol.jsonl");
    await writeFile(file, usageLine("a", { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
      + "\n" + usageLine("b", { input: 6, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }));
    const t = await readSessionUsage(file);
    expect(t.entries).toBe(2);
    expect(t.input).toBe(11);
  });

  it("deduplicates ids and returns identical results for concurrent calls on the same file", async () => {
    const file = join(dir, "dup.jsonl");
    const line = usageLine("m1", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    await writeFile(file, [line, line, usageLine("m2", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 })].join("\n"));
    const [a, b, c] = await Promise.all([
      readSessionUsage(file), readSessionUsage(file), readSessionUsage(file),
    ]);
    // single-flight：并发调用结果必须一致，且 id 去重仍生效
    expect(a.entries).toBe(2);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.input).toBe(101);
  });
});
