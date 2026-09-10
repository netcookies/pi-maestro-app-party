import { describe, expect, it } from "vitest";
import { HostSessionListService } from "../src/server/helpers.js";
import { join } from "node:path";

function record(id: string, updatedAt: string) {
  return { id, sessionId: id, cwd: "/p", title: id, updatedAt, created: updatedAt, model: undefined, messageCount: 1, path: `/p/${id}.jsonl` };
}

describe("HostSessionListService 后台刷新失败必须降级（不得把 I/O 故障升级成调用方异常）", () => {
  it("index 路径不可写：list() 仍返回旧快照且不抛（修复前：reload reject 沿 ensureLoaded/refresh 冒到调用方，甚至成 unhandledRejection → host fatal 退进程）", async () => {
    let now = 1_000;
    const svc = new HostSessionListService({
      // /dev/null 下的子路径：mkdir 必败 ENOTDIR（实测），可靠触发 reload() reject
      indexPath: join("/dev/null", "cannot-exist", "index.json"),
      staleAfterMs: 10,
      now: () => now,
    });
    // 首次 list：ensureLoaded 内 reload 失败被其 try/catch 吞掉，直接全量 load → 成功
    const first = await svc.list(async () => [record("a", "2026-01-01T00:00:00.000Z")], { limit: 5 });
    expect(first.sessions.map((s) => s.id)).toEqual(["a"]);
    // 变陈旧后 list：触发后台 reload（reject）。修复前这一行会抛 ENOTDIR；修复后必须返回可用快照
    now += 20;
    const second = await svc.list(async () => [record("b", "2026-01-02T00:00:00.000Z")], { limit: 5 });
    expect(second.sessions.length).toBeGreaterThanOrEqual(1);
    // 再等一拍：确认没有逃逸的 rejection（refresh 链已被 catch 收敛）
    await new Promise((r) => setTimeout(r, 60));
  });
});
