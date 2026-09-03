import type { HostEvent, SessionSnapshot, ExtensionUiResponse } from "@maestro-mobile/shared";
import type { RuntimeFactory, SessionRunner, OpenSessionRequest, HostEventListener } from "./types.js";
import { SdkSessionRunner } from "./session-runner.js";
import { MaestroStateReader } from "./maestro-state.js";
import { EventLog } from "./event-log.js";

/**
 * HostController — 集中管理所有会话 + Maestro 状态 + 事件分发
 *
 * 职责：
 * - 管理 SessionRunner 实例生命周期
 * - 注册 HostEventListener 事件监听（给 WebSocket 广播用）
 * - 调度 MaestroStateReader 定期读取
 * - 处理 client commands
 */
export class HostController {
  private readonly sessions = new Map<string, SessionRunner>();
  private readonly eventLog = new EventLog();
  private readonly listeners = new Set<HostEventListener>();
  private readonly maestroReader: MaestroStateReader;
  private readonly emitToListeners: (event: HostEvent) => void;
  private maestroPollTimer: ReturnType<typeof setInterval> | null = null;
  private _startedAt = Date.now();

  constructor(
    private readonly runtimeFactory: RuntimeFactory,
    maestroReader?: MaestroStateReader,
  ) {
    this.maestroReader = maestroReader ?? new MaestroStateReader();
    this.emitToListeners = (event: HostEvent) => {
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* ignore */ }
      }
    };
  }

  get startedAt(): number {
    return this._startedAt;
  }

  get activeSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** 注册事件监听（WebSocket 层订阅） */
  onEvent(listener: HostEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 获取状态信息 */
  getStatus(): { ok: boolean; version: string; maestroDetected: boolean; sessions: number; uptimeMs: number } {
    const uptimeMs = Date.now() - this._startedAt;
    return {
      ok: true,
      version: "0.1.0",
      maestroDetected: false, // 由 refreshMaestroState 更新
      sessions: this.sessions.size,
      uptimeMs,
    };
  }

  /** 启动 Maestro 状态轮询 */
  async startMaestroPoll(intervalMs = 5000): Promise<void> {
    await this.refreshMaestroState();
    this.maestroPollTimer = setInterval(() => {
      void this.refreshMaestroState();
    }, intervalMs);
  }

  stopMaestroPoll(): void {
    if (this.maestroPollTimer) {
      clearInterval(this.maestroPollTimer);
      this.maestroPollTimer = null;
    }
  }

  /** 列出所有会话（透传 runtimeFactory） */
  async listSessions(cwd?: string): Promise<unknown[]> {
    return this.runtimeFactory.listSessions(cwd);
  }

  /** 打开会话 */
  async openSession(request: OpenSessionRequest): Promise<SessionRunner> {
    const runner = await SdkSessionRunner.open(this.runtimeFactory, request, (event) => {
      this.emitToListeners(this.eventLog.record(event));
    });
    this.sessions.set(runner.id, runner);
    this.emitToListeners(this.eventLog.record({
      type: "host_status",
      status: `session ${runner.id} opened`,
    } as HostEvent));
    return runner;
  }

  /** 获取会话 */
  getSession(sessionId: string): SessionRunner | undefined {
    return this.sessions.get(sessionId);
  }

  /** 关闭会话 */
  async closeSession(sessionId: string): Promise<boolean> {
    const runner = this.sessions.get(sessionId);
    if (!runner) return false;
    this.sessions.delete(sessionId);
    await runner.dispose();
    return true;
  }

  /** 处理 extension_ui_response */
  respondToExtensionUi(sessionId: string, requestId: string, response: ExtensionUiResponse): boolean {
    const runner = this.sessions.get(sessionId);
    if (!runner) return false;
    return runner.respondToExtensionUi(requestId, response);
  }

  /** 刷新 Maestro 状态 */
  private async refreshMaestroState(): Promise<void> {
    try {
      const state = await this.maestroReader.readState();
      this.emitToListeners(this.eventLog.record({
        type: "maestro_state",
        state,
      }));
    } catch {
      // ignore
    }
  }

  /** 释放所有资源（关闭时调用） */
  async dispose(): Promise<void> {
    this.stopMaestroPoll();
    for (const runner of this.sessions.values()) {
      await runner.dispose();
    }
    this.sessions.clear();
    this.listeners.clear();
  }
}