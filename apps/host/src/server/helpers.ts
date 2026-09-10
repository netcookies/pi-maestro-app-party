/**
 * server/helpers — MobileHostServer 复用的纯函数（会话索引服务 + 安全文件读取）
 * （H9 拆分：会话摘要索引服务 + 安全图片文件读取）
 */
import { readFile, open, stat, mkdir, rename, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { HostSessionList, HostSessionSummary } from "@maestro-mobile/shared";

// ── 会话摘要 ─────────────────────────────────────────────────────────────────

/**
 * 将 SessionManager 返回的完整 SessionInfo 裁剪为移动端友好的摘要。
 * 关键：不携带 allMessagesText 等大字段，避免移动端流量/内存浪费。
 */
/** model 查询缓存：path → { mtimeMs, model }（jsonl 未变时跳过 tail 读取，消除全量列表的重复 IO） */
const modelCache = new Map<string, { mtimeMs: number; model: string | undefined }>();

export async function toSessionSummaryList(records: unknown[]): Promise<HostSessionList> {
  const recordsArr = records as Record<string, unknown>[];
  // 先并行取全部 model（分批 32 并发；mtime 未变的路径命中缓存，零 IO）
  const models = await Promise.all(recordsArr.map((r) => latestModelFromJsonlCached(String(r.path ?? r.sessionFile ?? ""))));
  const sessions: HostSessionSummary[] = recordsArr.map((r, i) => {
    const cwd = String(r.cwd ?? "");
    const title = String(r.firstMessage ?? r.title ?? "");
    const path = String(r.path ?? r.sessionFile ?? "");
    return {
      id: String(r.id ?? ""),
      cwd,
      cwdName: cwd.split("/").filter(Boolean).pop() ?? cwd,
      path,
      title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
      name: typeof r.name === "string" && r.name ? r.name : undefined,
      model: typeof r.model === "string" ? r.model : models[i],
      messageCount: typeof r.messageCount === "number" ? r.messageCount : 0,
      // 规范化为 ISO 字符串：Hermes（iOS）解析不了 "Thu Sep 03 2026 ..." 这种本地化格式
      updatedAt: normalizeIso(String(r.modified ?? r.updatedAt ?? "")),
      ...(r.created || r.createdAt ? { createdAt: normalizeIso(String(r.created ?? r.createdAt)) } : {}),
    };
  });
  return { sessions, observedAt: new Date().toISOString() };
}

export interface HostSessionListOptions {
  cwd?: string;
  limit?: number;
  cursor?: string;
  query?: string;
  sessionIds?: string[];
  latestForCwds?: string[];
}

export class HostSessionListService {
  private summaries: HostSessionSummary[] | undefined;
  private loadedAt = 0;
  private refresh: Promise<void> | undefined;

  constructor(private readonly options: { indexPath: string; staleAfterMs?: number; now?: () => number }) {}

  async list(load: () => Promise<unknown[]>, options: HostSessionListOptions = {}): Promise<HostSessionList> {
    this.validate(options);
    await this.ensureLoaded(load);
    const now = (this.options.now ?? Date.now)();
    if (now - this.loadedAt > (this.options.staleAfterMs ?? 10_000) && !this.refresh) {
      // 必须接 .catch：这是 fire-and-forget 的后台刷新，reload() 一旦 reject
      // （index 目录被删、.tmp 被并发 rename 抢走）就是 unhandledRejection，
      // 在 host 进程会命中 cli.ts 的 fatal() → 直接退整个守护进程。
      // 刷新失败只能降级为「用旧快照继续服务」，不能升级成进程级故障。
      this.refresh = this.reload(load)
        .catch((error: unknown) => {
          console.warn("[maestro-mobile] session index refresh failed (serving stale summary):", error instanceof Error ? error.message : error);
        })
        .finally(() => { this.refresh = undefined; });
    }
    const all = this.summaries ?? [];
    if (options.sessionIds || options.latestForCwds) {
      const ids = new Set(options.sessionIds ?? []);
      const cwds = new Set(options.latestForCwds ?? []);
      const latest = new Set<string>();
      for (const session of all) if (cwds.has(session.cwd) && !latest.has(session.cwd)) latest.add(session.cwd), ids.add(session.id);
      return { sessions: all.filter((session) => ids.has(session.id)), observedAt: new Date(now).toISOString(), targeted: true };
    }
    let filtered = options.cwd ? all.filter((session) => session.cwd === options.cwd) : all;
    const query = options.query?.trim().toLocaleLowerCase();
    if (query) filtered = filtered.filter((session) => [session.title, session.id, session.cwd, session.model, session.name].some((value) => value?.toLocaleLowerCase().includes(query)));
    if (options.limit === undefined) return { sessions: filtered, observedAt: new Date(now).toISOString() };
    let start = 0;
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      start = filtered.findIndex((session) => session.updatedAt < cursor.updatedAt || (session.updatedAt === cursor.updatedAt && session.id < cursor.id));
      if (start < 0) start = filtered.length;
    }
    const sessions = filtered.slice(start, start + options.limit);
    const hasMore = start + sessions.length < filtered.length;
    const last = sessions.at(-1);
    return { sessions, observedAt: new Date(now).toISOString(), hasMore, total: filtered.length, ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  private validate(options: HostSessionListOptions): void {
    const targeted = options.sessionIds !== undefined || options.latestForCwds !== undefined;
    for (const values of [options.sessionIds, options.latestForCwds]) {
      if (values && values.length > 100) throw new Error("targeted filters accept at most 100 values");
      if (values?.some((value) => typeof value !== "string" || value.length === 0)) throw new Error("targeted filters require non-empty strings");
    }
    if (targeted && (options.limit !== undefined || options.cursor !== undefined || options.query !== undefined || options.cwd !== undefined)) throw new Error("targeted session lookup cannot be combined with paging or search filters");
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new Error("limit must be between 1 and 100");
    if (options.cursor && options.limit === undefined) throw new Error("cursor requires limit");
    if (options.cursor) decodeCursor(options.cursor);
  }

  private async ensureLoaded(load: () => Promise<unknown[]>): Promise<void> {
    if (this.summaries) return;
    try {
      const parsed = JSON.parse(await readFile(this.options.indexPath, "utf8")) as { sessions?: HostSessionSummary[]; loadedAt?: number };
      if (!Array.isArray(parsed.sessions)) throw new Error("invalid index");
      this.summaries = parsed.sessions;
      this.loadedAt = parsed.loadedAt ?? (this.options.now ?? Date.now)();
    } catch {
      await this.reload(load);
    }
  }

  private async reload(load: () => Promise<unknown[]>): Promise<void> {
    const list = await toSessionSummaryList(await load());
    this.summaries = [...list.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    this.loadedAt = (this.options.now ?? Date.now)();
    // 持久化与内存刷新解耦：索引文件写失败（磁盘满/目录被删/并发 rename 抢 .tmp）
    // 只能降级为告警，不能让已在内存里的数据路径（含冷启动 ensureLoaded）向调用方抛错，
    // 更不能变成 unhandledRejection → cli fatal() 退整个 host 进程。
    try {
      await mkdir(join(this.options.indexPath, ".."), { recursive: true });
      const temp = `${this.options.indexPath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ sessions: this.summaries, loadedAt: this.loadedAt }), "utf8");
      await rename(temp, this.options.indexPath);
    } catch (error) {
      console.warn("[maestro-mobile] session index persist failed (serving from memory):", error instanceof Error ? error.message : error);
    }
  }
}

function encodeCursor(session: HostSessionSummary): string {
  return Buffer.from(JSON.stringify({ updatedAt: session.updatedAt, id: session.id })).toString("base64url");
}

function decodeCursor(raw: string): { updatedAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.updatedAt !== "string" || typeof value.id !== "string") throw new Error();
    return { updatedAt: value.updatedAt, id: value.id };
  } catch {
    throw new Error("invalid session cursor");
  }
}

/** 带 mtime 缓存的 model 查询（并发分批由调用方 Promise.all 控制，单次 tail 读本身轻量） */
async function latestModelFromJsonlCached(path: string): Promise<string | undefined> {
  if (!path || !path.endsWith(".jsonl")) return undefined;
  try {
    const { stat } = await import("node:fs/promises");
    const st = await stat(path);
    const cached = modelCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.model;
    const model = await latestModelFromJsonl(path);
    modelCache.set(path, { mtimeMs: st.mtimeMs, model });
    // 缓存防膨胀：超 2000 条时清掉最旧的 一半
    if (modelCache.size > 2000) {
      const keys = [...modelCache.keys()].slice(0, 1000);
      for (const k of keys) modelCache.delete(k);
    }
    return model;
  } catch {
    return undefined;
  }
}

/** 从 jsonl 里找最近的 model_change，返回 provider/modelId 精简名 */
async function latestModelFromJsonl(path: string): Promise<string | undefined> {
  if (!path || !path.endsWith(".jsonl")) return undefined;
  try {
    // 只读尾部 256KB（model_change 通常在会话活跃期靠后出现），避免整文件扫描
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const readLen = Math.min(TRAIL_READ_BYTES, size);
      const buf = Buffer.alloc(readLen);
      await handle.read(buf, 0, readLen, size - readLen);
      const tail = buf.toString("utf8");
      const lines = tail.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes("model_change")) continue;
        try {
          const o = JSON.parse(line) as { provider?: string; modelId?: string };
          if (o.modelId) {
            const provider = o.provider ? `${o.provider}/` : "";
            return `${provider}${o.modelId}`;
          }
        } catch {
          // ignore malformed
        }
      }
      return undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

const TRAIL_READ_BYTES = 256 * 1024;

/** 尝试解析为 ISO；无法解析时保留原字符串（App 端需兜底） */
function normalizeIso(raw: string): string {
  if (!raw) return "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : raw;
}

// ── 安全文件读取（图片预览）───────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** stat 包装（抛错由调用方捕获） */
function fstat(p: string): Promise<{ size: number }> {
  return stat(p) as unknown as Promise<{ size: number }>;
}

/** 安全读取本地图片：绝对路径 + 图片扩展名 + 大小限制 + realpath 防 symlink 绕过 */
export async function serveImageFile(filePath: string): Promise<{ data: Buffer; mime: string } | undefined> {
  const trimmed = filePath.trim();
  if (!trimmed || !isAbsolute(trimmed)) return undefined;
  // 防止路径穿越：normalize 后必须仍是绝对路径且不含 ..
  const normalized = normalize(trimmed);
  if (!isAbsolute(normalized) || normalized.includes("..")) return undefined;

  const ext = normalized.slice(normalized.lastIndexOf(".")).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return undefined;

  try {
    // P3-3：先解析真实路径，防止指向任意位置的 symlink 绕过绝对路径约束
    const resolved = await realpath(normalized);
    if (!(await isUnderAllowedRoot(resolved))) return undefined;
    // 先 stat 校验大小再读取，避免超大文件先耗尽内存
    const st = await fstat(resolved);
    if (st.size === 0 || st.size > MAX_IMAGE_BYTES) return undefined;
    const data = await readFile(resolved);
    return { data, mime: IMAGE_MIME[ext] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}

/** 允许读取的根目录：用户目录、系统临时目录、进程工作目录（会话产物、图片预览所在）。取 realpath 以兼容 /tmp → /private/tmp */
async function isUnderAllowedRoot(resolved: string): Promise<boolean> {
  const roots = [homedir(), tmpdir(), process.cwd()];
  for (const root of roots) {
    try {
      const rp = await realpath(root);
      if (resolved === rp || resolved.startsWith(rp + "/")) return true;
    } catch {
      // root 不存在时跳过
    }
  }
  return false;
}
