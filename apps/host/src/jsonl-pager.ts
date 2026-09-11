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
import { imageBlocksFromContent, materializeImages } from "./image-cache.js";

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
  // ring 容量（按 message 数计，与 cursor 语义一致）：需要返回窗口 + 1 前瞻
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
    // ring 保存 TimelineItem | null（null = message 未产生可渲染 item，如重复 toolResult）；
    // 长度按 message 数维护，cursor/hasMore 因此与 message 序号一致。
    const ring: (TimelineItem[] | null)[] = [];
    const seenToolResults = new Set<string>();
    let totalEntries = 0;
    let buf = "";
    // 异常超长行被截断后，直到下个换行前的内容都属于同一行，整行丢弃（与 usage-reader 同族修法）
    let skipToNewline = false;
    let skippedOversize = 0;

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      // 计数与丢弃统一在此：完整行超限 → 不计 totalEntries、不占 ring 位（避免窗口被无内容占位项吃掉）
      if (line.length > MAX_LINE_BYTES) {
        skippedOversize++;
        return;
      }
      if (!line.trimStart().startsWith("{")) return;
      // 只有 message 类型计入总数（session/model_change 等忽略）
      // 只有 message 与 custom_message 类型计入总数（session/model_change 等忽略）
      if (!line.includes('"type":"message"') && !line.includes('"type":"custom_message"')) return;
      totalEntries++;
      // ring 按 message 数保留最后 want 条（含 null 占位）
      if (ring.length >= want) {
        ring.shift();
      }
      const parsed = parseMessageLineItems(line, totalEntries - 1, seenToolResults);
      ring.push(parsed.length > 0 ? parsed : null);
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
        if (skipToNewline) { skipToNewline = false; continue; } // 超限行的尾巴
        handleLine(line);
      }
      // 残行必须有上限：handleLine 的 MAX_LINE_BYTES 只拦完整行，而 buf 本身无上限时
      // 畸形无换行文件会把它堆到接近文件大小
      if (buf.length > MAX_LINE_BYTES) {
        buf = "";
        skipToNewline = true;
        skippedOversize++; // 残行形态的超限：同一计数口径（否则旧实现下 16MB 单行会默默堆满内存）
      }
    }
    if (!skipToNewline && buf.trim()) handleLine(buf); // 最后无换行的行
    if (skippedOversize > 0) {
      console.warn(`[maestro-mobile] pager: ${filePath} 跳过 ${skippedOversize} 行超 ${MAX_LINE_BYTES} 字节的异常行`);
    }

    // ring 现在 = 最后 want 条 message（含 null 占位）。返回窗口 [skip, skip+limit) 的 item
    const end = Math.max(0, ring.length - opts.skip);
    const start = Math.max(0, end - opts.limit);
    const items: TimelineItem[] = ring
      .slice(start, end)
      .flatMap((messageItems) => messageItems ?? []);
    // hasMore：ring 里还有比窗口更早的 message（含占位）
    const hasMore = start > 0;
    const cursor = opts.skip + (end - start);

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
  return parseMessageLineItems(line, index, seenToolResults)[0];
}

function parseMessageLineItems(
  line: string,
  index: number,
  seenToolResults: Set<string>,
): TimelineItem[] {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  // 支持跨窗口注入的 custom_message（如从手机信箱注入到 TUI 的消息）
  if (entry.type === "custom_message") {
    const rawContent = typeof entry.content === "string" ? entry.content : "";
    const cut = rawContent.indexOf("\n---\n");
    const userText = cut >= 0 ? rawContent.slice(cut + 5).trim() : rawContent.trim();
    if (!userText) return [];
    const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : (typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : 0);
    const createdAt = timestamp > 0 ? new Date(timestamp).toISOString() : "";
    return [{
      id: `replay-custom-${index}`,
      kind: "user",
      text: userText,
      createdAt,
    }];
  }

  if (entry.type !== "message") return [];
  const msg = (entry.message ?? {}) as Record<string, unknown>;
  const role = String(msg.role ?? "");
  const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : 0;
  const createdAt = timestamp > 0 ? new Date(timestamp).toISOString() : "";

  if (role === "toolResult") {
    const toolCallId = String(msg.toolCallId ?? "");
    if (toolCallId && seenToolResults.has(toolCallId)) return [];
    if (toolCallId) seenToolResults.add(toolCallId);
    const text = extractText(msg.content);
    if (!text) return [];
    return [{
      id: `replay-tool-${index}`,
      kind: "tool",
      text,
      createdAt,
      toolName: String(msg.toolName ?? "tool"),
      toolCallId,
      isError: msg.isError === true,
    }];
  }
  if (role === "tool" || role === "toolCall") {
    const toolName = String(msg.toolName ?? "tool");
    const text = extractText(msg.content);
    return [{
      id: `replay-toolcall-${index}`,
      kind: "tool",
      text: text || `调用 ${toolName}`,
      createdAt,
      toolName,
    }];
  }

  const text = extractText(msg.content);
  if (role === "user") {
    const imagePaths = materializeImages(imageBlocksFromContent(msg.content));
    if (!text && imagePaths.length === 0) return [];
    return [{
      id: `replay-user-${index}`,
      kind: "user",
      text: imagePaths.length > 0 && !text ? `[🖼 ${imagePaths.length} 张图片]` : text,
      createdAt,
      ...(imagePaths.length > 0 ? { images: imagePaths } : {}),
    }];
  }
  if (role === "assistant" || role === "system") {
    const items: TimelineItem[] = [];
    if (text) items.push({ id: `replay-assistant-${index}`, kind: "assistant", text, createdAt });
    for (const callItem of toolCallImageItems(msg.content, createdAt)) {
      items.push({ ...callItem, id: `replay-toolcall-${index}-${items.length}` });
    }
    return items;
  }
  if (role === "thinking") {
    if (!text) return [];
    return [{ id: `replay-thinking-${index}`, kind: "thinking", text, createdAt }];
  }
  return [];
}

/**
 * 搜索 jsonl 中匹配关键词的消息（返回文件顺序中的匹配项 + 其 timeline 下标范围）
 * 返回匹配消息的序号（从 0 开始，按文件 message 顺序）和文本片段。
 */
export async function searchInJsonl(
  filePath: string,
  keyword: string,
  maxResults = 50,
): Promise<{ matches: { index: number; text: string; kind: string }[]; totalEntries: number }> {
  if (!keyword.trim()) return { matches: [], totalEntries: 0 };
  const kw = keyword.toLowerCase();
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fd = await open(filePath, "r");
    const { size } = await fd.stat();
    const matches: { index: number; text: string; kind: string }[] = [];
    let totalEntries = 0;
    let buf = "";
    let skippedOversize = 0;
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      // 单行上限：旧实现连这一层都没有， malformed 巨行会进入 JSON.parse；而真正无上限的是 buf 残行（见下方守卫）
      if (line.length > MAX_LINE_BYTES) {
        skippedOversize++;
        return;
      }
      if (!line.includes('"type":"message"') && !line.includes('"type":"custom_message"')) return;
      totalEntries++;
      if (matches.length >= maxResults) return;
      try {
        const entry = JSON.parse(line) as {
          message?: { role?: string; content?: unknown };
        };
        const role = entry.message?.role ?? "";
        const text = extractText(entry.message?.content ?? "");
        if (text.toLowerCase().includes(kw)) {
          matches.push({
            index: totalEntries - 1,
            text: text.slice(0, 120),
            kind: role,
          });
        }
      } catch {
        // ignore
      }
    };
    let pos = 0;
    let skipToNewline = false;
    while (pos < size) {
      const readLen = Math.min(READ_CHUNK, size - pos);
      const chunk = Buffer.alloc(readLen);
      await fd.read(chunk, 0, readLen, pos);
      pos += readLen;
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (skipToNewline) { skipToNewline = false; continue; }
        handleLine(line);
      }
      // 同 scanWindow：残行必须有上限，否则畸形无换行文件会把 buf 堆到接近文件大小
      if (buf.length > MAX_LINE_BYTES) {
        buf = "";
        skipToNewline = true;
        skippedOversize++;
      }
    }
    if (!skipToNewline && buf.trim()) handleLine(buf);
    if (skippedOversize > 0) {
      console.warn(`[maestro-mobile] pager.search: ${filePath} 跳过 ${skippedOversize} 行超 ${MAX_LINE_BYTES} 字节的异常行`);
    }
    return { matches, totalEntries };
  } finally {
    await fd?.close();
  }
}

function toolCallImageItems(content: unknown, createdAt: string): TimelineItem[] {
  if (!Array.isArray(content)) return [];
  const items: TimelineItem[] = [];
  for (const block of content) {
    const value = block as Record<string, unknown>;
    if (value.type !== "toolCall" || value.name !== "read") continue;
    const argsValue = value.arguments;
    let args: Record<string, unknown> | undefined;
    if (argsValue && typeof argsValue === "object") {
      args = argsValue as Record<string, unknown>;
    } else if (typeof argsValue === "string") {
      try {
        const parsed = JSON.parse(argsValue) as unknown;
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
      } catch {
        args = undefined;
      }
    }
    const path = typeof args?.path === "string" ? args.path.trim() : "";
    if (path && TOOL_IMAGE_EXT.test(path)) {
      items.push({ id: "", kind: "tool", text: path, createdAt, toolName: "read" });
    }
  }
  return items;
}

const TOOL_IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

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