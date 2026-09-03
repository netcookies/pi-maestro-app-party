/**
 * ExtensionUiQueue — 管理移动端收到的 ask 弹窗请求（select/input/confirm）
 *
 * 这是解决 maestro ask 在移动端可用的核心：
 * host 推送 extension_ui_request → 这里排队 → UI 渲染弹窗 → 用户作答 → 返回响应
 */
import type { ExtensionUiRequest, ExtensionUiResponse, DistributiveOmitUiResponse } from "@maestro-mobile/shared";

export type DialogStatus = "pending" | "answered" | "cancelled" | "expired";

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

  get pendingDialogs(): DialogEntry[] {
    const now = this.now();
    // 惰性过期：返回前清理超时的
    const result: DialogEntry[] = [];
    for (const [id, entry] of this.dialogs) {
      if (entry.status !== "pending") continue;
      if (now - entry.receivedAt > (entry.request.timeout ?? this.defaultTimeoutMs)) {
        this.dialogs.set(id, { ...entry, status: "expired" });
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  get count(): number {
    return this.pendingDialogs.length;
  }

  /** 入队新弹窗（同一 session 的请求） */
  enqueue(request: ExtensionUiRequest): DialogEntry {
    const entry: DialogEntry = {
      request,
      receivedAt: this.now(),
      status: "pending",
    };
    this.dialogs.set(request.id, entry);
    return entry;
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