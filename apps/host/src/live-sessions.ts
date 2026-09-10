/**
 * LiveSessionsService — 只读感知"当前正在运行的 Pi 会话"（vibe coding 中）
 *
 * 核心思路：
 *  - 扫描 Pi 的会话文件目录（与 TUI 共享）
 *  - 解析每个文件的 updatedAt/entryCount
 *  - 最近活跃的会话标记为 live（正在运行）
 *
 * 关键特性：**只读**，不 claim workspace owner，不与真实 Pi 会话冲突。
 */
import { readdir, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface LiveSessionInfo {
  sessionId: string;
  cwdName: string;
  path: string;
  firstMessage: string;
  entryCount: number;
  messageCount: number;
  updatedAt: number;
  /** 距现在 < liveThresholdMs 视为活跃中 */
  live: boolean;
  liveAgeMs: number;
}

export interface LiveSessionList {
  sessions: LiveSessionInfo[];
  observedAt: string;
  /** 活跃会话数 */
  liveCount: number;
}

export interface LiveSessionsOptions {
  /** Pi 会话目录，默认 ~/.pi/agent/sessions */
  sessionsRoot?: string;
  /** 视为"活跃"的时间阈值 ms，默认 60s */
  liveThresholdMs?: number;
  /** 每个目录最多读取的会话数（防止巨量扫描） */
  maxPerCwd?: number;
  now?: () => number;
}

export class LiveSessionsService {
  private readonly sessionsRoot: string;
  private readonly liveThresholdMs: number;
  private readonly maxPerCwd: number;
  private readonly now: () => number;
  /** P2-6：entryCount 按 mtime 缓存（文件未变时跳过流式扫描，避免每 5s 全量读盘） */
  private readonly lineCountCache = new Map<string, { mtimeMs: number; count: number }>();

  constructor(options: LiveSessionsOptions = {}) {
    this.sessionsRoot = options.sessionsRoot ?? join(homedir(), ".pi", "agent", "sessions");
    this.liveThresholdMs = options.liveThresholdMs ?? 60_000;
    this.maxPerCwd = options.maxPerCwd ?? 50;
    this.now = options.now ?? Date.now;
  }

  get root(): string {
    return this.sessionsRoot;
  }

  /** 列出所有会话（按 updatedAt 降序），标记活跃会话 */
  async list(): Promise<LiveSessionList> {
    const observedAt = this.now();
    const sessions: LiveSessionInfo[] = [];

    let cwdDirs: string[];
    try {
      cwdDirs = await readdir(this.sessionsRoot);
    } catch {
      return { sessions: [], observedAt: new Date(observedAt).toISOString(), liveCount: 0 };
    }

    for (const cwdDir of cwdDirs) {
      if (!cwdDir.startsWith("--")) continue; // 只处理 --cwd-- 格式
      const cwdPath = join(this.sessionsRoot, cwdDir);
      const cwdName = decodeCwdDir(cwdDir);

      let files: string[];
      try {
        files = await readdir(cwdPath);
      } catch {
        continue;
      }

      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      // 按修改时间取最新 maxPerCwd 个
      const withMtime: { file: string; mtime: number }[] = [];
      for (const f of jsonlFiles) {
        try {
          const s = await stat(join(cwdPath, f));
          withMtime.push({ file: f, mtime: s.mtimeMs });
        } catch {
          // ignore
        }
      }
      withMtime.sort((a, b) => b.mtime - a.mtime);
      const top = withMtime.slice(0, this.maxPerCwd);

      for (const { file, mtime } of top) {
        const fullPath = join(cwdPath, file);
        const info = await this.readSessionInfo(fullPath, cwdName, mtime);
        if (info) sessions.push(info);
      }
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    const liveCount = sessions.filter((s) => s.live).length;
    return { sessions, observedAt: new Date(observedAt).toISOString(), liveCount };
  }

  /** 条目数 = 非空行数；mtime 未变时用缓存，变化时流式重扫并更新缓存 */
  private async countEntries(
    path: string,
    handle: Awaited<ReturnType<typeof open>>,
    mtimeMs: number,
  ): Promise<number> {
    const cached = this.lineCountCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.count;
    try {
      const count = await countLinesStreamed(handle, path);
      this.lineCountCache.set(path, { mtimeMs, count });
      return count;
    } catch {
      return cached?.count ?? 0;
    }
  }

  /** 解析单个会话文件（只读头部 + 行数），标记是否活跃 */
  private async readSessionInfo(
    path: string,
    cwdNameFromDir: string,
    mtimeMs: number,
  ): Promise<LiveSessionInfo | undefined> {
    try {
      // 读前几行解析 sessionId、cwd 和 firstMessage
      const handle = await import("node:fs/promises").then((m) => m.open(path, "r"));
      try {
        const headBuf = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(headBuf, 0, headBuf.length, 0);
        const head = headBuf.subarray(0, bytesRead).toString("utf8");

        // sessionId 从文件名取（Pi 格式: <ts>_<uuid>.jsonl）
        const fileName = basename(path, ".jsonl");
        const txid = fileName.match(/_([0-9a-f-]{36})$/i)?.[1];
        const sessionId = txid ?? fileName;

        // cwd 优先从首行 session 记录的 cwd 字段取（目录名有 - 转义歧义）
        const cwd = extractCwdFromHeader(head) ?? cwdNameFromDir;
        const firstMessage = extractFirstMessage(head);
        const entryCount = await this.countEntries(path, handle, mtimeMs);

        const age = this.now() - mtimeMs;
        return {
          sessionId,
          cwdName: cwd,
          path,
          firstMessage,
          entryCount,
          messageCount: entryCount, // 近似
          updatedAt: mtimeMs,
          live: age < this.liveThresholdMs,
          liveAgeMs: Math.max(0, age),
        };
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
}

/** 从首行 session JSON 提取 cwd（精确路径，无转义歧义） */
function extractCwdFromHeader(head: string): string | undefined {
  const line = head.split("\n")[0];
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

/** 将 --Users-isulewli-Projects-foo-- 解码为 /Users/isulewli/Projects/foo（绝对路径） */
function decodeCwdDir(dir: string): string {
  const inner = dir.replace(/^--/, "").replace(/--$/, "");
  return `/${inner.replace(/-/g, "/")}`;
}

/** 从首行 JSONL 提取第一条消息文本 */
function extractFirstMessage(head: string): string {
  const line = head.split("\n")[0];
  if (!line) return "";
  try {
    const parsed = JSON.parse(line) as { text?: string; content?: unknown; type?: string };
    if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.slice(0, 120);
    // 尝试 content 数组
    if (Array.isArray(parsed.content)) {
      const texts = parsed.content
        .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
        .filter(Boolean);
      if (texts.length > 0) return texts.join(" ").slice(0, 120);
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * P2-6：流式分块统计非空行数（等价于整读 split("\n") 的结果，但内存恒定），
 * 并按 mtime 缓存 —— 文件未变化时直接复用上次计数，轮询时不再整读大文件。
 */
const COUNT_CHUNK_BYTES = 512 * 1024;
/**
 * 残行上限：本函数只判断「该行是否非空」，所以截断不改变计数（用 carryNonEmpty 保留已见非空白的事实）。
 * 不封顶时，畸形无换行文件会让 carry 逐块增长到接近文件大小（与 usage-reader/jsonl-pager 同族问题）。
 */
const MAX_CARRY_CHARS = 64 * 1024;

async function countLinesStreamed(handle: Awaited<ReturnType<typeof open>>, pathForLog: string): Promise<number> {
  const { size } = await handle.stat();
  let count = 0;
  let carry = ""; // 块边界的残行，拼入下一块后再按行处理
  let carryTruncated = false; // carry 被截断后，它「原本非空」这个事实
  let skippedOversize = 0;
  let pos = 0;
  while (pos < size) {
    const readLen = Math.min(COUNT_CHUNK_BYTES, size - pos);
    const chunk = Buffer.alloc(readLen);
    await handle.read(chunk, 0, readLen, pos);
    pos += readLen;
    const text = carry + chunk.toString("utf8");
    const lines = text.split("\n");
    // 最后一段可能是残行（后面还有块），留到下一轮；末块时一并处理
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (carryTruncated || line.trim().length > 0) count++;
      carryTruncated = false;
    }
    if (carry.length > MAX_CARRY_CHARS) {
      carryTruncated = carry.trim().length > 0;
      carry = "";
      skippedOversize++;
    }
  }
  if (carryTruncated || carry.trim().length > 0) count++; // 无换行结尾的残行
  if (skippedOversize > 0) {
    // 可观测性：旧实现静默把残行堆到接近文件大小。告警频率受 mtime 缓存约束（文件未变不重扫）。
    console.warn(`[maestro-mobile] live-sessions: ${pathForLog} 残行超 ${MAX_CARRY_CHARS} 字符被截断（${skippedOversize} 次），行数仍按 1 行计`);
  }
  return count;
}

export { decodeCwdDir };