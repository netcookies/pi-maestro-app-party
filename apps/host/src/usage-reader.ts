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
import { readFile, readdir, stat } from "node:fs/promises";
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
  const num = (k: string): number => (typeof usage[k] === "number" && Number.isFinite(usage[k]) ? usage[k] as number : 0);
  const costObj = usage.cost as Record<string, unknown> | undefined;
  const cost = costObj && typeof costObj.total === "number" && Number.isFinite(costObj.total) ? costObj.total : 0;
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
 * 聚合一个 JSONL 文件的 usage（全量读取；大文件流式逐行，按 id 去重）
 * 返回 EMPTY_TOTALS 也可能是「文件存在但无 usage」——调用方用 stat 区分
 */
export async function readSessionUsage(sessionFile: string): Promise<UsageTotals> {
  let raw: string;
  try {
    raw = await readFile(sessionFile, "utf8");
  } catch {
    return EMPTY_TOTALS;
  }
  const seenIds = new Set<string>();
  let totals = EMPTY_TOTALS;
  for (const line of raw.split("\n")) {
    if (!line.includes('"usage"')) continue;
    // id 去重：流式补写同一条 message 可能重复出现
    let id: string | undefined;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === "string") id = parsed.id;
    } catch {
      // 解析失败仍尝试聚合 usage 行本身
    }
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    totals = addTotals(totals, parseUsageLine(line));
  }
  return totals;
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
