/**
 * JsonlTailWatcher — 实时增量监听外部进程向会话 JSONL 文件写入的新消息
 *
 * 核心职责：
 * 1. 增量跟踪：启动时光标定在当前文件末尾（不重复发射历史），外部写入新行时增量读取。
 * 2. 行缓冲解析：处理分块读取导致的跨块残行，将 message 格式解析为 TimelineItem[]。
 * 3. 严格生命周期管理（高优先级）：
 *    - 会话切换/关闭时，dispose() 必须 100% 释放底层 FileHandle 与停止定时器。
 *    - 防止任何孤儿句柄泄漏或后台无效轮询。
 */
import { stat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { TimelineItem } from "@maestro-mobile/shared";
import { imageBlocksFromContent, materializeImages } from "./image-cache.js";

export interface JsonlTailWatcherOptions {
  /** 轮询检测间隔（ms），默认 250ms */
  pollIntervalMs?: number;
  /** 单次读取最大字节数，默认 64KB */
  maxChunkBytes?: number;
  /** 单条 JSONL 行的最大 UTF-8 字节数，超过后丢弃到下一个换行。 */
  maxLineBytes?: number;
  /** 测试注入的当前时间函数 */
  now?: () => number;
}

export class JsonlTailWatcher {
  private readonly pollIntervalMs: number;
  private readonly maxChunkBytes: number;
  private readonly now: () => number;
  private readonly maxLineBytes: number;

  private currentOffset = 0;
  private carry = "";
  private droppingOversizedLine = false;
  private fileIdentity: string | null = null;
  private replayPending = false;
  private replayObservedSize = 0;
  private replayStablePolls = 0;
  private fileHandle: FileHandle | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;
  private isChecking = false;
  private seq = 0;

  constructor(
    private readonly filePath: string,
    private readonly onItems: (items: TimelineItem[], appendedEntries: number, replayed: boolean, replaySettled: boolean) => void,
    options: JsonlTailWatcherOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxChunkBytes = options.maxChunkBytes ?? 65_536;
    this.now = options.now ?? Date.now;
    this.maxLineBytes = options.maxLineBytes ?? 1_048_576;
  }

  /**
   * 启动监听：先探知当前文件末尾作为游标起点，随后开启轮询
   */
  async start(): Promise<void> {
    if (this.isDisposed) return;
    try {
      const fileStat = await stat(this.filePath);
      if (fileStat.isFile()) {
        this.currentOffset = fileStat.size;
        this.fileIdentity = `${fileStat.dev}:${fileStat.ino}`;
      }
    } catch {
      // 文件若尚不存在，保持 offset=0；首次物化后的内容属于 watcher 注册后的增量。
      this.currentOffset = 0;
    }

    if (this.isDisposed) return;

    this.pollTimer = setInterval(() => {
      void this.checkNewContent();
    }, this.pollIntervalMs);
    // unref 避免阻止进程正常退出
    this.pollTimer.unref?.();
  }

  /**
   * 释放资源（严格生命周期管理）：
   * 1. 停止定时器
   * 2. 关闭底层 FileHandle
   * 3. 清空缓冲区，标记 disposed
   */
  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.fileHandle) {
      const handle = this.fileHandle;
      this.fileHandle = null;
      try {
        await handle.close();
      } catch {
        // 关闭失败静默（可能已损坏或已被系统释放）
      }
    }

    this.carry = "";
    this.droppingOversizedLine = false;
    this.replayPending = false;
  }

  get offset(): number {
    return this.currentOffset;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  /**
   * 单次增量检查与读取
   */
  async checkNewContent(): Promise<void> {
    if (this.isDisposed || this.isChecking) return;
    this.isChecking = true;

    try {
      let fileStat;
      try {
        fileStat = await stat(this.filePath);
      } catch {
        return; // 文件可能被临时删除或未生成
      }

      if (!fileStat.isFile()) return;

      const newSize = fileStat.size;
      const identity = `${fileStat.dev}:${fileStat.ino}`;
      const identityChanged = this.fileIdentity !== null && identity !== this.fileIdentity;
      if (this.fileIdentity === null || identityChanged) this.fileIdentity = identity;

      // Compact can truncate in place or atomically replace the file. Close the old
      // handle before replaying so subsequent reads follow the current inode.
      const resetFromStart = newSize < this.currentOffset || identityChanged;
      if (resetFromStart) {
        this.currentOffset = 0;
        this.replayPending = true;
        this.replayObservedSize = newSize;
        this.replayStablePolls = 0;
        this.carry = "";
        this.droppingOversizedLine = false;
        if (this.fileHandle) {
          const handle = this.fileHandle;
          this.fileHandle = null;
          await handle.close().catch(() => {});
        }
      } else if (this.replayPending && newSize !== this.replayObservedSize) {
        this.replayObservedSize = newSize;
        this.replayStablePolls = 0;
      }

      if (this.replayPending && newSize === this.currentOffset) {
        this.replayStablePolls += 1;
        if (this.replayStablePolls >= 2) {
          this.replayPending = false;
          this.onItems([], 0, true, true);
        }
        return;
      }
      if (newSize === this.currentOffset) {
        return; // 无新内容
      }

      // 打开并复用/按需维护 FileHandle
      if (!this.fileHandle) {
        this.fileHandle = await open(this.filePath, "r");
      }

      if (this.isDisposed) {
        await this.fileHandle.close();
        this.fileHandle = null;
        return;
      }

      const readOffset = this.currentOffset;
      const bytesToRead = Math.min(newSize - readOffset, this.maxChunkBytes);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await this.fileHandle.read(buffer, 0, bytesToRead, readOffset);

      if (bytesRead > 0) {
        this.currentOffset += bytesRead;
        const chunkStr = buffer.toString("utf8", 0, bytesRead);
        this.processChunk(chunkStr, !this.replayPending);
      }
    } catch {
      // 读错误时安全释放句柄，下次轮询重新尝试 open
      if (this.fileHandle) {
        try {
          await this.fileHandle.close();
        } catch { /* ignore */ }
        this.fileHandle = null;
      }
    } finally {
      this.isChecking = false;
    }
  }

  private processChunk(chunk: string, countAppends = true): void {
    let combined = this.carry + chunk;
    let lines = combined.split("\n");
    let remainder = lines.pop() ?? "";

    if (this.droppingOversizedLine) {
      const newline = combined.indexOf("\n");
      if (newline < 0) return;
      this.droppingOversizedLine = false;
      combined = combined.slice(newline + 1);
      lines = combined.split("\n");
      remainder = lines.pop() ?? "";
    }

    if (Buffer.byteLength(remainder, "utf8") > this.maxLineBytes) {
      this.carry = "";
      this.droppingOversizedLine = true;
    } else {
      this.carry = remainder;
    }

    const newItems: TimelineItem[] = [];
    let appendedEntries = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const items = this.parseLine(trimmed);
      if (countAppends) {
        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          if (entry.type === "message" || entry.type === "custom_message") appendedEntries += 1;
        } catch {
          // parseLine already rejects malformed JSON; no append entry to count here.
        }
      }
      if (items.length > 0) {
        newItems.push(...items);
      }
    }

    if ((newItems.length > 0 || appendedEntries > 0) && !this.isDisposed) {
      this.onItems(newItems, appendedEntries, !countAppends, false);
    }
  }

  private parseLine(line: string): TimelineItem[] {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }

    // 支持跨窗口注入的 custom_message（如从手机信箱注入到 TUI 的消息实时同步给客户端）
    if (entry.type === "custom_message") {
      const rawContent = typeof entry.content === "string" ? entry.content : "";
      const cut = rawContent.indexOf("\n---\n");
      const userText = cut >= 0 ? rawContent.slice(cut + 5).trim() : rawContent.trim();
      if (!userText) return [];
      const timestamp = typeof entry.timestamp === "number"
        ? new Date(entry.timestamp).toISOString()
        : (typeof entry.timestamp === "string" ? new Date(entry.timestamp).toISOString() : new Date(this.now()).toISOString());
      return [{
        id: `tail-custom-${++this.seq}`,
        kind: "user",
        text: userText,
        createdAt: timestamp,
      }];
    }

    if (entry.type !== "message") return [];
    const msg = (entry.message ?? {}) as Record<string, unknown>;
    const role = String(msg.role ?? "");
    const createdAt = typeof msg.timestamp === "number"
      ? new Date(msg.timestamp).toISOString()
      : new Date(this.now()).toISOString();

    const items: TimelineItem[] = [];

    if (role === "user") {
      const content = extractText(msg.content);
      const imageBlocks = imageBlocksFromContent(msg.content);
      const imagePaths = materializeImages(imageBlocks);
      items.push({
        id: `tail-user-${++this.seq}`,
        kind: "user",
        text: imagePaths.length > 0 && !content ? `[🖼 ${imagePaths.length} 张图片]` : content,
        createdAt,
        ...(imagePaths.length > 0 ? { images: imagePaths } : {}),
      });
    } else if (role === "assistant" || role === "system") {
      const content = extractText(msg.content);
      if (content) {
        items.push({
          id: `tail-${role}-${++this.seq}`,
          kind: role as "assistant" | "system",
          text: content,
          createdAt,
        });
      }
    } else if (role === "thinking") {
      const content = extractText(msg.content);
      if (content) {
        items.push({
          id: `tail-thinking-${++this.seq}`,
          kind: "thinking",
          text: content,
          createdAt,
        });
      }
    } else if (role === "tool" || role === "toolCall") {
      const toolName = String(msg.toolName ?? "tool");
      const text = extractText(msg.content) || (msg.text as string | undefined) || "";
      items.push({
        id: `tail-toolcall-${++this.seq}`,
        kind: "tool",
        text: text || `调用 ${toolName}`,
        createdAt,
        toolName,
      });
    } else if (role === "toolResult") {
      const toolName = String(msg.toolName ?? "tool");
      const text = extractText(msg.content) || (msg.text as string | undefined) || "";
      if (text) {
        items.push({
          id: `tail-tool-${++this.seq}`,
          kind: "tool",
          text,
          createdAt,
          toolName,
          toolCallId: String(msg.toolCallId ?? ""),
          isError: msg.isError === true,
        });
      }
    }

    return items;
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}
