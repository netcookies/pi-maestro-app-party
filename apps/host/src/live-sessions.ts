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
import { readdir, stat, readFile } from "node:fs/promises";
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

  constructor(options: LiveSessionsOptions = {}) {
    this.sessionsRoot = options.sessionsRoot ?? join(homedir(), ".pi", "agent", "sessions");
    this.liveThresholdMs = options.liveThresholdMs ?? 60_000;
    this.maxPerCwd = options.maxPerCwd ?? 20;
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
        const entryCount = await countLines(path, handle);

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

/** 快速统计 jsonl 行数（用已打开的文件句柄） */
async function countLines(path: string, handle: Awaited<ReturnType<typeof import("node:fs/promises").open>>): Promise<number> {
  // 简化：用 readFile 分块统计 \n
  const { readFile } = await import("node:fs/promises");
  try {
    const content = await readFile(path, "utf8");
    return content.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

export { decodeCwdDir };