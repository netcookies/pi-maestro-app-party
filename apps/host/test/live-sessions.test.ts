import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
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