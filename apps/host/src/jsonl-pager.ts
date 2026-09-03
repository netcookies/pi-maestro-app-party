/**
 * jsonl-pager — jsonl 会话文件的分页读取（懒加载核心）
 *
 * 长会话不再一次性解析全部：
 *  - 首次只取尾部 limit 条（tail）
 *  - 滚动到顶部时，按批次向前取更早的（page）
 *
 * 实现：
 *  正向分块扫描整文件，但只保留两条信息：
 *  1. ring buffer：最后 limit+skip 条 item（用于 tail / page 返回）
 *  2. 文件 message 总数
 *  扫描是流式的（分块读），内存只保留窗口大小，不驻留全量。
 *
 * cursor 语义：已经发给客户端的历史条数（从尾部往前数）。
 *  cursor=0 表示还没发过任何历史（首次 tail）
 *  cursor=N 表示尾部 N 条已发，下一页往前取更早的。
 */
import { open } from "node:fs/promises";
import type { TimelineItem } from "@maestro-mobile/shared";

export interface PageResult {
  items: TimelineItem[];
  hasMore: boolean;
  /** 新的 cursor = 已消费尾部条数 */
  cursor: number;
  totalEntries: number;
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK = 512 * 1024;

/** 首次加载：取最后 limit 条（此时 cursor=0，skip=0） */
export async function replayTailFromJsonl(filePath: string, limit = 100): Promise<PageResult> {
  return scanWindow(filePath, { limit, skip: 0 });
}

/**
 * 继续向前翻页：已发 cursor 条（尾部），再取更早的 limit 条。
 * 等价于 window = [total - cursor - limit, total - cursor)
 */
export async function replayPageFromJsonl(
  filePath: string,
  cursor: number,
  count = 100,
): Promise<PageResult> {
  if (cursor <= 0) return { items: [], hasMore: false, cursor: 0, totalEntries: 0 };
  return scanWindow(filePath, { limit: count, skip: cursor });
}

interface WindowOptions {
  limit: number;
  /** 从尾部跳过的条数（已消费） */
  skip: number;
}

async function scanWindow(filePath: string, opts: WindowOptions): Promise<PageResult> {
  // ring 容量 = 需要返回的窗口 + 1 条前瞻（判断是否还有更早）
  const want = opts.limit + opts.skip + 1;
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let opened = true;
    try {
      fd = await open(filePath, "r");
    } catch {
      opened = false;
    }
    if (!opened || !fd) {
      return { items: [], hasMore: false, cursor: 0, totalEntries: 0 };
    }
    const ring: TimelineItem[] = [];
    const seenToolResults = new Set<string>();
    let totalEntries = 0;
    let buf = "";

    const handleLine = (line: string) => {
      if (!line.trim() || line.length > MAX_LINE_BYTES) return;
      if (!line.trimStart().startsWith("{")) return;
      // 只有 message 类型计入总数（session/model_change 等忽略）
      if (!line.includes('"type":"message"')) return;
      totalEntries++;
      // ring 只保留最后 want 个 ITEM（以 item 数为准；message 可能不产生 item）
      if (ring.length >= want) {
        ring.shift();
      }
      const item = parseMessageLine(line, totalEntries - 1, seenToolResults);
      if (item) ring.push(item);
    };

    const { size } = await fd.stat();
    if (size === 0) return { items: [], hasMore: false, cursor: 0, totalEntries: 0 };
    let pos = 0;
    while (pos < size) {
      const readLen = Math.min(READ_CHUNK, size - pos);
      const chunk = Buffer.alloc(readLen);
      await fd.read(chunk, 0, readLen, pos);
      pos += readLen;
      buf += chunk.toString("utf8");
      // 处理完整行
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    if (buf.trim()) handleLine(buf); // 最后无换行的行

    // ring 现在 = 最后 want 条（文件顺序）。要返回 [skip, skip+limit)
    // start>0 表示 ring 里还有比窗口更早的 item（= hasMore）
    const end = Math.max(0, ring.length - opts.skip);
    const start = Math.max(0, end - opts.limit);
    const items = ring.slice(start, end);
    const hasMore = start > 0;
    const cursor = opts.skip + items.length;

    return { items, hasMore, cursor, totalEntries };
  } finally {
    await fd?.close();
  }
}

export function parseMessageLine(
  line: string,
  index: number,
  seenToolResults: Set<string>,
): TimelineItem | undefined {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (entry.type !== "message") return undefined;
  const msg = (entry.message ?? {}) as Record<string, unknown>;
  const role = String(msg.role ?? "");
  const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : 0;
  const createdAt = timestamp > 0 ? new Date(timestamp).toISOString() : "";

  if (role === "toolResult") {
    const toolCallId = String(msg.toolCallId ?? "");
    if (toolCallId && seenToolResults.has(toolCallId)) return undefined;
    if (toolCallId) seenToolResults.add(toolCallId);
    const text = extractText(msg.content);
    if (!text) return undefined;
    return {
      id: `replay-tool-${index}`,
      kind: "tool",
      text,
      createdAt,
      toolName: String(msg.toolName ?? "tool"),
      toolCallId,
      isError: msg.isError === true,
    };
  }
  if (role === "tool" || role === "toolCall") {
    const toolName = String(msg.toolName ?? "tool");
    const text = extractText(msg.content);
    return {
      id: `replay-toolcall-${index}`,
      kind: "tool",
      text: text || `调用 ${toolName}`,
      createdAt,
      toolName,
    };
  }

  const text = extractText(msg.content);
  if (role === "user") {
    return { id: `replay-user-${index}`, kind: "user", text, createdAt };
  }
  if (role === "assistant" || role === "system") {
    if (!text) return undefined;
    return { id: `replay-assistant-${index}`, kind: "assistant", text, createdAt };
  }
  if (role === "thinking") {
    if (!text) return undefined;
    return { id: `replay-thinking-${index}`, kind: "thinking", text, createdAt };
  }
  return undefined;
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