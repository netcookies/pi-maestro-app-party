/**
 * jsonl-index — 会话文件 message 行偏移索引（H8 性能修复）
 *
 * 问题：replayPageFromJsonl 每页都从 pos=0 流式扫描整个文件，
 * 连续翻页成本 O(页数 × 文件大小)。
 *
 * 方案：首次扫描时记录每条 message 行的 byte offset（按行界对齐），
 * 后续页直接从 offset 区间读取对应行，成本 O(页大小)。
 * 索引以 (path, size, mtimeMs) 为键做模块级 LRU 缓存（容量 8），
 * 文件被 Pi 追加写入后 size 变化自动失效重建。
 */
import { open } from "node:fs/promises";

export interface JsonlIndex {
  /** 每条 message 行的 [startOffset, endOffset)（endOffset 含换行符后的下一行起点） */
  messageOffsets: number[];
  /** message 总数 */
  totalEntries: number;
  /** 索引建立时的文件大小（追加写入检测用） */
  size: number;
  mtimeMs: number;
}

const MAX_INDEXED_FILES = 8;
const indexCache = new Map<string, JsonlIndex>();

export function getCachedIndex(filePath: string, size: number, mtimeMs: number): JsonlIndex | undefined {
  const hit = indexCache.get(filePath);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit;
  return undefined;
}

export function putCachedIndex(filePath: string, index: JsonlIndex): void {
  indexCache.set(filePath, index);
  if (indexCache.size > MAX_INDEXED_FILES) {
    // Map 迭代序 = 插入序，删最旧
    const oldest = indexCache.keys().next().value;
    if (oldest !== undefined) indexCache.delete(oldest);
  }
}

const READ_CHUNK = 512 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * 建立（或读取缓存的）message 行偏移索引。
 * 只记录「type":"message」行的起始 offset；与 jsonl-pager 的行判定一致。
 */
export async function buildMessageIndex(filePath: string): Promise<JsonlIndex> {
  const fd = await open(filePath, "r");
  try {
    const stat = await fd.stat();
    const cached = getCachedIndex(filePath, stat.size, stat.mtimeMs);
    if (cached) return cached;

    const messageOffsets: number[] = [];
    let pos = 0;
    let buf = "";
    let bufStart = 0; // buf[0] 对应的文件 offset
    while (pos < stat.size) {
      const readLen = Math.min(READ_CHUNK, stat.size - pos);
      const chunk = Buffer.alloc(readLen);
      await fd.read(chunk, 0, readLen, pos);
      pos += readLen;
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        if (line.trim() && line.length <= MAX_LINE_BYTES && (line.includes('"type":"message"') || line.includes('"type":"custom_message"'))) {
          messageOffsets.push(bufStart);
        }
        buf = buf.slice(nl + 1);
        bufStart += nl + 1;
      }
    }
    // 末尾无换行的残行
    if (buf.trim() && buf.length <= MAX_LINE_BYTES && (buf.includes('"type":"message"') || buf.includes('"type":"custom_message"'))) {
      messageOffsets.push(bufStart);
    }

    const index: JsonlIndex = {
      messageOffsets,
      totalEntries: messageOffsets.length,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    putCachedIndex(filePath, index);
    return index;
  } finally {
    await fd.close();
  }
}

/** 清除某文件的索引（测试用） */
export function invalidateIndex(filePath: string): void {
  indexCache.delete(filePath);
}
