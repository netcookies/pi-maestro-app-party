import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LiveSessionsService, decodeCwdDir } from "../src/live-sessions.js";

describe("LiveSessionsService", () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `live-sess-${randomUUID()}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeSession(cwdDir: string, fileName: string, content: string, mtimeMs: number) {
    const dir = join(root, cwdDir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, fileName);
    await writeFile(path, content);
    // 修改 mtime
    const utimes = await import("node:fs/promises").then((m) => m.utimes);
    await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
    return path;
  }

  it("returns empty when no sessions root", async () => {
    const svc = new LiveSessionsService({ sessionsRoot: join(root, "nonexistent") });
    const list = await svc.list();
    expect(list.sessions).toEqual([]);
    expect(list.liveCount).toBe(0);
  });

  it("lists sessions with cwd names and marks live ones", async () => {
    const now = Date.now();
    const svc = new LiveSessionsService({ sessionsRoot: root, now: () => now });

    const cwdDir = "--Users-isulewli-Projects-foo--";
    await writeSession(
      cwdDir,
      "2026-09-03T10-00-00-000Z_aaaa-1111-2222-3333-444444444444.jsonl",
      '{"type":"user","text":"帮我重构这段代码","timestamp":"2026-09-03T10:00:00Z"}\n{"type":"assistant","text":"好的","timestamp":"2026-09-03T10:00:01Z"}\n',
      now - 10_000, // 10 秒前 = 活跃
    );
    await writeSession(
      cwdDir,
      "2026-09-03T09-00-00-000Z_bbbb-1111-2222-3333-444444444444.jsonl",
      '{"type":"user","text":"旧会话","timestamp":"2026-09-03T09:00:00Z"}\n',
      now - 3_600_000, // 1 小时前 = 不活跃
    );

    const list = await svc.list();
    expect(list.sessions.length).toBe(2);
    expect(list.liveCount).toBe(1);

    const live = list.sessions.find((s) => s.live);
    expect(live?.sessionId).toContain("aaaa");
    expect(live?.cwdName).toBe("/Users/isulewli/Projects/foo");
    expect(live?.firstMessage).toContain("帮我重构这段代码");
    expect(live?.entryCount).toBe(2);

    // 排序：活跃的最新在前
    expect(list.sessions[0].live).toBe(true);
  });

  it("sorts by updatedAt descending", async () => {
    const now = Date.now();
    const svc = new LiveSessionsService({ sessionsRoot: root, now: () => now });

    for (const [name, mtime] of [
      ["a.jsonl", now - 5000],
      ["b.jsonl", now - 1000],
      ["c.jsonl", now - 9000],
    ] as const) {
      await writeSession("--tmp-x--", name, '{"type":"user","text":"x"}\n', mtime);
    }

    const list = await svc.list();
    expect(list.sessions.map((s) => s.sessionId)).toEqual(["b", "a", "c"]);
  });

  it("handles corrupt files gracefully", async () => {
    const now = Date.now();
    const svc = new LiveSessionsService({ sessionsRoot: root, now: () => now });
    await writeSession("--tmp-x--", "bad.jsonl", "not json at all", now - 1000);
    const list = await svc.list();
    // 无法解析首行也应列出（sessionId 从文件名取）
    expect(list.sessions.length).toBe(1);
    expect(list.sessions[0].firstMessage).toBe("");
  });
});

describe("decodeCwdDir", () => {
  it("decodes cwd directory names", () => {
    expect(decodeCwdDir("--Users-isulewli-Projects-foo--")).toBe("/Users/isulewli/Projects/foo");
    expect(decodeCwdDir("--opt-homebrew-lib--")).toBe("/opt/homebrew/lib");
  });
});
// 泛化发现回归：countLinesStreamed 的残行上限（与 usage-reader / jsonl-pager 同族）。
// 旧实现 carry 无上限：畸形无换行文件会把它堆到接近文件大小。
// 本函数只判断「该行是否非空」，所以截断后仍须按 1 行计（carryTruncated 传递该事实），
// 且截断位点不能把同一行重复计数。
describe("LiveSessionsService oversized carry bound", () => {
  const MB = 1024 * 1024;
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `live-carry-${randomUUID()}`);
    await mkdir(join(root, "--tmp-x--"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function entryCount(content: string): Promise<number | undefined> {
    const path = join(root, "--tmp-x--", `${randomUUID()}.jsonl`);
    await writeFile(path, content);
    const t = new Date(Date.now() - 1000);
    await utimes(path, t, t);
    const svc = new LiveSessionsService({ sessionsRoot: root, now: () => Date.now() });
    try {
      const list = await svc.list();
      // 目录里必须只有本次写入的文件，否则 sessions[0] 取到谁取决于排序，用例不传递确定语义
      expect(list.sessions.length, "fixture 泄漏：应仅有本次写入的文件").toBe(1);
      return list.sessions[0]?.entryCount;
    } finally {
      await rm(path, { force: true }); // 不删则下次调用多文件共存
    }
  }

  it("无换行巨行仍计为 1 行，且截断不重复计数后续行", async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(" ")); });
    try {
      const huge = "x".repeat(3 * MB); // 远超 MAX_CARRY_CHARS，且必然跨多个 512KB chunk
      const baseline = warns.length;
      expect(await entryCount(huge)).toBe(1);
      expect(await entryCount(`${huge}\nsecond\n`)).toBe(2);
      // 截断行的尾巴只剩空白：不得被当成新的一行重复计数
      expect(await entryCount(`${huge} \n`)).toBe(1);
      // 只断言「新增」的告警：vitest 仍会把 console.warn 写进 reporter，绝对条数不稳定
      const afterHuge = warns.length;
      expect(afterHuge, "巨行必须产生截断告警（否则退回到静默无上限累积）").toBeGreaterThan(baseline);
      expect(warns.slice(baseline).some((w) => w.includes("残行超"))).toBe(true);
      // 守卫不能误杀正常文件：正常内容不再新增告警
      expect(await entryCount('{"a":1}\n{"b":2}\n{"c":3}\n')).toBe(3);
      expect(warns.length).toBe(afterHuge);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
