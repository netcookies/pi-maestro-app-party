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

function usageLine(id: string, usage: Record<string, unknown>, type = "message"): string {
  return JSON.stringify({ type, id, message: { role: "assistant", usage } });
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

  it("computes totalTokens as sum of parts when totalTokens field absent", () => {
    const t = parseUsageLine(usageLine("a2", { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7 }));
    expect(t.totalTokens).toBe(162);
  });

  it("returns zeros for non-message entries", () => {
    expect(parseUsageLine(JSON.stringify({ type: "model_change", id: "m1" }))).toEqual(EMPTY_TOTALS);
  });

  it("returns zeros for malformed JSON and missing usage", () => {
    expect(parseUsageLine("not json")).toEqual(EMPTY_TOTALS);
    expect(parseUsageLine(JSON.stringify({ type: "message", id: "x", message: { role: "user" } }))).toEqual(EMPTY_TOTALS);
  });

  it("treats non-finite numbers as zero", () => {
    const t = parseUsageLine(usageLine("a3", { input: Number.MAX_VALUE, output: "bad", cacheRead: NaN }));
    expect(t.entries).toBe(1);
    expect(t.output).toBe(0);
    expect(t.cacheRead).toBe(0);
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
    expect(t.totalTokens).toBe(300 + 30 + 5 + 0 + 3);
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
