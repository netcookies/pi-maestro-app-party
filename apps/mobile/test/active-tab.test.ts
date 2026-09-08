import { describe, expect, it } from "vitest";
import type { HostSessionSummary } from "@maestro-mobile/shared";

// 复刻 host-sessions 的 isSessionActive 逻辑（纯函数抽取验证）
function makeSession(id: string, cwd: string, updatedAt: string): HostSessionSummary {
  return { id, cwd, cwdName: cwd, path: `/p/${id}.jsonl`, title: id, messageCount: 0, updatedAt } as HostSessionSummary;
}

describe("活跃 tab 判定（Monitor running 窗口归并）", () => {
  const live = new Set(["live-1"]);
  const runningCwds = new Set(["/proj/a"]);
  const sessions = [
    makeSession("live-1", "/proj/b", "2026-09-08T10:00:00Z"),
    makeSession("stale-a", "/proj/a", "2026-09-08T09:00:00Z"),
    makeSession("latest-a", "/proj/a", "2026-09-08T10:05:00Z"),
    makeSession("other", "/proj/c", "2026-09-08T10:06:00Z"),
  ];
  const latestPerCwd = new Map<string, HostSessionSummary>();
  for (const s of sessions) {
    const cur = latestPerCwd.get(s.cwd);
    if (!cur || new Date(s.updatedAt) > new Date(cur.updatedAt)) latestPerCwd.set(s.cwd, s);
  }
  const isActive = (s: HostSessionSummary) =>
    live.has(s.id) || (runningCwds.has(s.cwd) && latestPerCwd.get(s.cwd)?.id === s.id);

  it("live 会话活跃", () => expect(isActive(sessions[0])).toBe(true));
  it("running 窗口 cwd 的最新会话活跃（即使 mtime 超 60s）", () => expect(isActive(sessions[2])).toBe(true));
  it("同 cwd 非最新会话不活跃", () => expect(isActive(sessions[1])).toBe(false));
  it("非 running cwd 的会话不活跃", () => expect(isActive(sessions[3])).toBe(false));
  it("活跃计数 = 2（live-1 + latest-a）", () => expect(sessions.filter(isActive).length).toBe(2));
});
