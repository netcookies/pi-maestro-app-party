/**
 * ExtensionUiQueue — 管理移动端收到的 ask 弹窗请求（select/input/confirm）
 *
 * 这是解决 maestro ask 在移动端可用的核心：
 * host 推送 extension_ui_request → 这里排队 → UI 渲染弹窗 → 用户作答 → 返回响应
 */
import type { ExtensionUiRequest, ExtensionUiResponse, DistributiveOmitUiResponse } from "@maestro-mobile/shared";

export type DialogStatus = "pending" | "answered" | "cancelled" | "expired";

/** 交互类方法：需要用户响应，作为弹窗显示 */
const INTERACTIVE_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * 驻留上限：dialogs Map 此前只改 status 从不 delete（expired/answered/cancelled 永久驻留），
 * 长时间运行 + 频繁 ask 会话下无界增长。上限只在唯一的增长点（enqueue）上修剪，
 * 因此不改变 pendingDialogs/get 的现有可见语义（过期条目仍可被 get 查到一次）。
 * 取 64：同一时刻待用户作完的弹窗远小于此值，超出部分必为已终态/已过期的残留。
 */
export const MAX_QUEUED_DIALOGS = 64;

export function isInteractiveMethod(method: string): boolean {
  return INTERACTIVE_METHODS.has(method);
}

export interface DialogEntry {
  request: ExtensionUiRequest;
  receivedAt: number;
  status: DialogStatus;
}

export interface ExtensionUiQueueOptions {
  /** 弹窗超时（ms），默认 2 分钟 */
  defaultTimeoutMs?: number;
  now?: () => number;
}

export class ExtensionUiQueue {
  private readonly dialogs = new Map<string, DialogEntry>();
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: ExtensionUiQueueOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.now = options.now ?? Date.now;
  }

  /** 惰性过期：把超时的 pending 条目标为 expired（两处共用同一判定） */
  private sweepExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.dialogs) {
      if (entry.status !== "pending") continue;
      if (now - entry.receivedAt > (entry.request.timeout ?? this.defaultTimeoutMs)) {
        this.dialogs.set(id, { ...entry, status: "expired" });
      }
    }
  }

  /**
   * 回收终态条目（answered/cancelled/expired），优先最早的插入。
   * 若全为未过期 pending 则不强制丢（它们仍然用户可见），
   * 下一次过期后会被 sweep 标终态并可被修剪。
   */
  private pruneFinished(): void {
    this.sweepExpired();
    while (this.dialogs.size > MAX_QUEUED_DIALOGS) {
      let victim: string | undefined;
      for (const [id, entry] of this.dialogs) {
        if (entry.status !== "pending") { victim = id; break; }
      }
      if (!victim) break;
      this.dialogs.delete(victim);
    }
  }

  get pendingDialogs(): DialogEntry[] {
    // 惰性过期：返回前清理超时的
    this.sweepExpired();
    const result: DialogEntry[] = [];
    for (const entry of this.dialogs.values()) {
      if (entry.status !== "pending") continue;
      result.push(entry);
    }
    return result;
  }

  get count(): number {
    return this.pendingDialogs.length;
  }

  /** 入队新弹窗（同一 session 的请求）
   *  只有交互类方法（select/confirm/input/editor）需要用户响应；
   *  setStatus/setTitle/notify/setWidget 等 fire-and-forget 通知不入队。 */
  enqueue(request: ExtensionUiRequest): DialogEntry | undefined {
    if (!isInteractiveMethod(request.method)) return undefined;
    const entry: DialogEntry = {
      request,
      receivedAt: this.now(),
      status: "pending",
    };
    this.dialogs.set(request.id, entry);
    // 唯一会增大 Map 的入口：在同一处修剪，保证驻留有界
    this.pruneFinished();
    return entry;
  }

  /**
   * 发送失败时把弹窗恢复为 pending（保留用户已选答案）。
   *
   * 不能用 enqueue 代替（S_CONFIRM 实测发现的回归）：enqueue 会用 now() 重建 receivedAt，
   * 使一个早已过期、host 侧已放弃的 ask 复活并重获完整超时。
   * 因此：保留原 receivedAt；已过期则保持终态；条目已被修剪时无法判定原始时限，保守不恢复。
   */
  reopen(request: ExtensionUiRequest): boolean {
    const existing = this.dialogs.get(request.id);
    if (!existing) return false;
    const timeout = request.timeout ?? this.defaultTimeoutMs;
    if (this.now() - existing.receivedAt > timeout) return false;
    this.dialogs.set(request.id, { ...existing, status: "pending" });
    this.pruneFinished(); // 保持驻留有界；只删终态条目，不会误删刚恢复的 pending
    return true;
  }

  /** 获取弹窗 */
  get(requestId: string): DialogEntry | undefined {
    return this.dialogs.get(requestId);
  }

  /** 用户作答 → 构造响应并移除 */
  answer(requestId: string, response: DistributiveOmitUiResponse): ExtensionUiResponse | undefined {
    const entry = this.dialogs.get(requestId);
    if (!entry || entry.status !== "pending") return undefined;
    const full: ExtensionUiResponse = { id: requestId, ...response } as ExtensionUiResponse;
    this.dialogs.set(requestId, { ...entry, status: "answered" });
    return full;
  }

  /** 用户取消 */
  cancel(requestId: string): ExtensionUiResponse | undefined {
    const entry = this.dialogs.get(requestId);
    if (!entry || entry.status !== "pending") return undefined;
    this.dialogs.set(requestId, { ...entry, status: "cancelled" });
    return { id: requestId, cancelled: true };
  }

  /** 清空某 session 的所有弹窗（会话关闭/切换时） */
  clearSession(sessionId: string): number {
    let count = 0;
    for (const [id, entry] of this.dialogs) {
      if (entry.request.sessionId === sessionId) {
        this.dialogs.delete(id);
        count++;
      }
    }
    return count;
  }

  /** 全部清空 */
  clearAll(): number {
    const count = this.dialogs.size;
    this.dialogs.clear();
    return count;
  }
}