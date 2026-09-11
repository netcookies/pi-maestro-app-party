import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { JsonlTailWatcher } from "../src/jsonl-tail-watcher.js";
import type { TimelineItem } from "@maestro-mobile/shared";

describe("JsonlTailWatcher (AC1, AC2, AC5)", () => {
  const dirs: string[] = [];

  async function makeFixture(initialLines: string[] = []) {
    const dir = await mkdtemp(join(tmpdir(), `mm-tail-${randomUUID()}`));
    dirs.push(dir);
    const filePath = join(dir, "session.jsonl");
    const content = initialLines.map((l) => JSON.stringify(l)).join("\n") + (initialLines.length > 0 ? "\n" : "");
    await writeFile(filePath, content, "utf8");
    return { dir, filePath };
  }

  afterEach(async () => {
    while (dirs.length) {
      await rm(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("AC1: 初始跳过历史内容，外部追加新行时增量触发回调", async () => {
    const initial = [
      { type: "message", id: "m1", message: { role: "user", content: "旧问题" } },
      { type: "message", id: "m2", message: { role: "assistant", content: "旧回答" } },
    ];
    const { filePath } = await makeFixture(initial);

    const received: TimelineItem[] = [];
    const watcher = new JsonlTailWatcher(filePath, (items) => {
      received.push(...items);
    }, { pollIntervalMs: 50 });

    await watcher.start();
    expect(received).toHaveLength(0); // 启动时不重复回放历史

    // 外部进程（桌面 TUI）追加一条新问答
    const newLine = JSON.stringify({
      type: "message",
      id: "m3",
      message: { role: "user", content: "新提问" },
    }) + "\n";
    await appendFile(filePath, newLine, "utf8");

    // 手动触发或等待轮询
    await watcher.checkNewContent();

    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("user");
    expect(received[0].text).toBe("新提问");

    await watcher.dispose();
  });

  it("AC2: 严格生命周期管理——dispose() 必须释放底层 FileHandle 并注销定时器", async () => {
    const { filePath } = await makeFixture([]);
    const received: TimelineItem[] = [];
    const watcher = new JsonlTailWatcher(filePath, (items) => received.push(...items), { pollIntervalMs: 50 });

    await watcher.start();
    // 外部写入触发句柄打开
    const line = JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: "回复1" } }) + "\n";
    await appendFile(filePath, line, "utf8");
    await watcher.checkNewContent();

    expect(received).toHaveLength(1);

    // 反向验证 / 检查白盒属性
    const internal = watcher as unknown as {
      fileHandle: { close: () => Promise<void> } | null;
      pollTimer: unknown;
    };
    expect(internal.fileHandle, "读内容后应持有活跃 FileHandle").not.toBeNull();
    const handleCloseSpy = vi.spyOn(internal.fileHandle!, "close");

    // 调用 dispose()
    await watcher.dispose();

    expect(watcher.disposed).toBe(true);
    expect(handleCloseSpy, "dispose() 必须显式调用 handle.close()").toHaveBeenCalledTimes(1);
    expect(internal.fileHandle, "dispose() 后内部句柄必须置为 null").toBeNull();
    expect(internal.pollTimer, "dispose() 后轮询定时器必须被清空").toBeNull();

    // 再次写入，dispose 后的 watcher 不得再读取或触发回调
    await appendFile(filePath, JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: "迟到消息" } }) + "\n", "utf8");
    await watcher.checkNewContent();
    expect(received).toHaveLength(1); // 仍为 1，不再增长
  });

  it("AC5: 文件被截断缩小（compact 重写）时，自动重置游标不崩溃", async () => {
    const { filePath } = await makeFixture([
      { type: "message", id: "m1", message: { role: "user", content: "很长很长的历史消息".repeat(100) } },
    ]);
    const received: TimelineItem[] = [];
    const watcher = new JsonlTailWatcher(filePath, (items) => received.push(...items), { pollIntervalMs: 50 });
    await watcher.start();
    const initialOffset = watcher.offset;
    expect(initialOffset).toBeGreaterThan(1000);

    // 模拟 compact：会话文件被压缩重写为只有 1 条简短消息（文件大小变小）
    const compactContent = JSON.stringify({
      type: "message",
      id: "m_compact",
      message: { role: "assistant", content: "总结" },
    }) + "\n";
    await writeFile(filePath, compactContent, "utf8");

    // 触发检查
    await watcher.checkNewContent();

    // 游标安全重置并读出了重写后的内容
    expect(received.some((r) => r.text === "总结")).toBe(true);
    expect(watcher.offset).toBeLessThan(initialOffset);

    await watcher.dispose();
  });

  it("残行缓冲与分块拼接：未换行内容暂存，换行到达时完整解析", async () => {
    const { filePath } = await makeFixture([]);
    const received: TimelineItem[] = [];
    const watcher = new JsonlTailWatcher(filePath, (items) => received.push(...items), { pollIntervalMs: 50 });
    await watcher.start();

    // 先写入前半截
    const full = JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: "跨块流式文本" } }) + "\n";
    const part1 = full.slice(0, 30);
    const part2 = full.slice(30);

    await appendFile(filePath, part1, "utf8");
    await watcher.checkNewContent();
    expect(received).toHaveLength(0); // 残行未闭合，不触发

    // 补齐后半截
    await appendFile(filePath, part2, "utf8");
    await watcher.checkNewContent();
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("跨块流式文本");

    await watcher.dispose();
  });
});
