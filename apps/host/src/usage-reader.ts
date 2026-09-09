/**
 * usage-reader — 会话 JSONL 的 token usage 聚合（纯函数模块，可单测）
 *
 * 数据源合同（已实证）：
 *   ~/.pi/agent/sessions/<--cwd--dir>/<sessionId>.jsonl
 *   每条 {"type":"message", "id":..., "message":{"role":"assistant","model":...,
 *     "usage":{"input":N,"output":N,"cacheRead":N,"cacheWrite":N,"reasoning":N,
 *              "totalTokens":N,"cost":{"input":..,"output":..,"total":..}}}}
 *
 * 聚合语义（实测验证）：
 *  - totalTokens = input + output + cacheRead + cacheWrite + reasoning（各部分之和，非独立增量）
 *  - input 每轮重复计入上下文，「今日消耗」以 output/cost 为主指标、totalTokens 做参考
 *  - 条目 id 可能因流式补写重复出现，必须按 id 去重
 *  - usage 缺失（用户消息/工具消息）直接跳过
 */
import { readdir, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface UsageTotals {
  /** assistant 轮次（含 usage 的 message 条目数，已去重） */
  entries: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** input+output+cacheRead+cacheWrite+reasoning 之和（参考值） */
  totalTokens: number;
  /** 累计成本（美元，模型定价;免费模型为 0） */
  cost: number;
}

export interface SessionUsage {
  sessionId: string;
  /** JSONL 文件路径（不存在时 path 为空） */
  path: string;
  totals: UsageTotals;
}

export const EMPTY_TOTALS: UsageTotals = {
  entries: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0,
};

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    entries: a.entries + b.entries,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
  };
}

/** 单条 JSONL 行 → UsageTotals（非 message 条目 / 无 usage / 数值异常均返回零） */
export function parseUsageLine(line: string): UsageTotals {
  if (!line.includes('"usage"')) return EMPTY_TOTALS;
  let d: unknown;
  try {
    d = JSON.parse(line);
  } catch {
    return EMPTY_TOTALS;
  }
  if (!d || typeof d !== "object") return EMPTY_TOTALS;
  const rec = d as Record<string, unknown>;
  if (rec.type !== "message") return EMPTY_TOTALS;
  const message = rec.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return EMPTY_TOTALS;
  // token/cost 要求非负有限：损坏行产生负 totals 或精度失真会污染聚合
  const num = (k: string): number => {
    const v = usage[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  };
  const costObj = usage.cost as Record<string, unknown> | undefined;
  const costRaw = costObj?.total;
  const cost = typeof costRaw === "number" && Number.isFinite(costRaw) && costRaw >= 0 ? costRaw : 0;
  const input = num("input"), output = num("output"), cacheRead = num("cacheRead"),
    cacheWrite = num("cacheWrite"), reasoning = num("reasoning");
  return {
    entries: 1,
    input, output, cacheRead, cacheWrite, reasoning,
    totalTokens: input + output + cacheRead + cacheWrite + reasoning,
    cost,
  };
}

/**
 * 聚合一个 JSONL 文件的 usage（流式分块逐行，内存恒定；按 id 去重）。
 * 返回 EMPTY_TOTALS 也可能是「文件存在但无 usage」——调用方用 stat 区分。
 *
 * 不采用 readFile + raw.split("\n")：实测单文件可达 165MB，完整字符串 + split 数组 +
 * UTF-16 行内容同时驻留，峰值远高于文件体积，多次/并发扫描会撞 V8 堆上限（~4.2GB）直接 OOM abort。
 * 同时受限于全局并发闸 + 同文件 single-flight，避免多客户端重复扫同一份大文件。
 */
export async function readSessionUsage(sessionFile: string): Promise<UsageTotals> {
  const existing = inflightScans.get(sessionFile);
  if (existing) return existing;
  const scan = (async (): Promise<UsageTotals> => {
    await acquireScanSlot();
    try {
      return await scanUsageFile(sessionFile);
    } catch {
      // 文件不存在 / 不可读：保持原有语义，返回零值
      return EMPTY_TOTALS;
    } finally {
      releaseScanSlot();
    }
  })();
  inflightScans.set(sessionFile, scan);
  try {
    return await scan;
  } finally {
    inflightScans.delete(sessionFile);
  }
}

/** 分块读取字节数；与 live-sessions countLinesStreamed 保持同一量级 */
const SCAN_CHUNK_BYTES = 512 * 1024;
/** 单行上限：与 jsonl-pager MAX_LINE_BYTES 对齐（实测真实 jsonl 最长行 2.30MB，不会漏算 usage） */
const MAX_USAGE_LINE_BYTES = 4 * 1024 * 1024;
/** 全局同时扫描的文件数上限：防多客户端并发大文件扫描叠加导致 OOM */
const MAX_CONCURRENT_USAGE_SCANS = 2;

let activeScans = 0;
const scanWaiters: (() => void)[] = [];
const inflightScans = new Map<string, Promise<UsageTotals>>();

async function acquireScanSlot(): Promise<void> {
  if (activeScans >= MAX_CONCURRENT_USAGE_SCANS) {
    await new Promise<void>((resolve) => scanWaiters.push(resolve));
  }
  activeScans++;
}

function releaseScanSlot(): void {
  activeScans--;
  scanWaiters.shift()?.();
}

/** 流式逐行扫描：以 0x0A 字节切行（UTF-8 多字节序列不会出现该字节，安全） */
async function scanUsageFile(sessionFile: string): Promise<UsageTotals> {
  const handle = await open(sessionFile, "r");
  try {
    const { size } = await handle.stat();
    const seenIds = new Set<string>();
    let totals = EMPTY_TOTALS;
    // 跳过的超长行计数：不静默归因于“无 usage”
    let skippedLines = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    let pos = 0;

    const consume = (line: Buffer): void => {
      if (line.length === 0 || line.indexOf('"usage"') === -1) return;
      if (line.length > MAX_USAGE_LINE_BYTES) {
        skippedLines++;
        return;
      }
      const text = line.toString("utf8");
      // id 去重：流式补写同一条 message 可能重复出现
      let id: string | undefined;
      try {
        const parsed = JSON.parse(text) as { id?: unknown };
        if (typeof parsed.id === "string") id = parsed.id;
      } catch {
        // 解析失败仍尝试聚合 usage 行本身
      }
      if (id) {
        if (seenIds.has(id)) return;
        seenIds.add(id);
      }
      totals = addTotals(totals, parseUsageLine(text));
    };

    while (pos < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(SCAN_CHUNK_BYTES, size - pos), pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const data = chunk.subarray(0, bytesRead);

      let lineStart = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0x0a) continue;
        const segment = data.subarray(lineStart, i);
        consume(pendingBytes > 0 ? Buffer.concat([...pending, segment]) : segment);
        pending = [];
        pendingBytes = 0;
        lineStart = i + 1;
      }
      if (lineStart < data.length) {
        // 必须拷贝：data 是复用的 chunk 视图，下一轮 handle.read 会就地覆盖，
        // 直接存视图会让跨块残行读到被污染的字节（实测会丢 usage 行）
        pending.push(Buffer.from(data.subarray(lineStart)));
        pendingBytes += data.length - lineStart;
        // 单行本身超大时直接丢弃残行，不把无上限的行堆进内存
        if (pendingBytes > MAX_USAGE_LINE_BYTES) {
          skippedLines++;
          pending = [];
          pendingBytes = 0;
        }
      }
    }

    // 无换行结尾的残行
    if (pendingBytes > 0) consume(Buffer.concat(pending));

    if (skippedLines > 0) {
      console.warn(`[maestro-mobile] usage: ${sessionFile} 跳过 ${skippedLines} 行超 ${MAX_USAGE_LINE_BYTES} 字节的异常行`);
    }
    return totals;
  } finally {
    await handle.close();
  }
}

/**
 * 按时间过滤聚合多个会话文件（Dashboard「今日/7 天」用）
 * sinceMs: 只统计 mtime >= 该时间戳的文件（文件级过滤，不逐条按时间过滤——
 * 会话文件的 usage 是全程累积的，按条目时间切割需要完整解析，成本高且语义偏移）
 */
export async function readRecentUsage(
  files: { path: string; mtimeMs: number }[],
  sinceMs: number,
): Promise<{ totals: UsageTotals; files: number }> {
  let totals = EMPTY_TOTALS;
  let count = 0;
  for (const f of files) {
    if (f.mtimeMs < sinceMs) continue;
    totals = addTotals(totals, await readSessionUsage(f.path));
    count++;
  }
  return { totals, files: count };
}

/** 列出全部会话 JSONL（mtime 降序；扫描失败安全返回空） */
export async function listSessionFiles(sessionsRoot = join(homedir(), ".pi", "agent", "sessions")): Promise<{ path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  let cwdDirs: string[];
  try {
    cwdDirs = await readdir(sessionsRoot);
  } catch {
    return out;
  }
  for (const dir of cwdDirs) {
    if (!dir.startsWith("--")) continue;
    const dirPath = join(sessionsRoot, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dirPath, f);
      try {
        const s = await stat(path);
        out.push({ path, mtimeMs: s.mtimeMs });
      } catch {
        // skip
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 从 sessionId 反查 JSONL 路径（telemetry owner → sessionFile） */
export async function resolveSessionFile(sessionId: string, sessionsRoot = join(homedir(), ".pi", "agent", "sessions")): Promise<string | undefined> {
  if (!sessionId) return undefined;
  let cwdDirs: string[];
  try {
    cwdDirs = await readdir(sessionsRoot);
  } catch {
    return undefined;
  }
  for (const dir of cwdDirs) {
    if (!dir.startsWith("--")) continue;
    const candidate = join(sessionsRoot, dir, `${sessionId}.jsonl`);
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

/** sessionId 提取：文件路径 → basename 去掉 .jsonl */
export function sessionIdFromPath(sessionFile: string): string {
  return basename(sessionFile, ".jsonl");
}
