import type { HostEvent, SessionSnapshot, ExtensionUiResponse } from "@maestro-mobile/shared";
import type { RuntimeFactory, SessionRunner, OpenSessionRequest, HostEventListener } from "./types.js";
import { SdkSessionRunner } from "./session-runner.js";
import { MaestroStateReader } from "./maestro-state.js";
import { LiveSessionsService } from "./live-sessions.js";
import { WorkspaceTelemetryReader } from "./workspace-telemetry.js";
import { projectMonitorState, telemetryStableKey, monitorStateEvent } from "./monitor-projection.js";
import { VersionDetector, type ComponentVersions } from "./version-detector.js";
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
  private readonly liveSessions: LiveSessionsService;
  private readonly telemetryReader: WorkspaceTelemetryReader;
  private telemetryCache: string | null = null;
  private telemetryInFlight = false;
  private readonly emitToListeners: (event: HostEvent) => void;
  private maestroPollTimer: ReturnType<typeof setInterval> | null = null;
  private maestroDetected = false;
  private readonly versionDetector = new VersionDetector();
  private componentVersions: ComponentVersions = {};
  private _startedAt = Date.now();

  constructor(
    private readonly runtimeFactory: RuntimeFactory,
    maestroReader?: MaestroStateReader,
  ) {
    this.maestroReader = maestroReader ?? new MaestroStateReader();
    this.liveSessions = new LiveSessionsService();
    this.telemetryReader = new WorkspaceTelemetryReader();
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

  /** 读取活跃会话列表（只读，不 claim owner） */
  async listLiveSessions() {
    return this.liveSessions.list();
  }

  /** 读取 workspace telemetry（owner 状态，Monitor/Teammate 合同） */
  async readTelemetry() {
    return this.telemetryReader.read();
  }

  /** 轮询 telemetry，状态变化时推送 monitor_state 事件（single-flight + 稳定键变更检测） */
  async pollTelemetry(): Promise<void> {
    if (this.telemetryInFlight) return;
    this.telemetryInFlight = true;
    try {
      const t = await this.telemetryReader.read();
      const key = telemetryStableKey(t);
      if (key === this.telemetryCache) return;
      this.telemetryCache = key;
      this.emitToListeners(this.eventLog.record(monitorStateEvent(projectMonitorState(t))));
    } catch {
      // 读取失败保留上次快照，不广播空窗口
    } finally {
      this.telemetryInFlight = false;
    }
  }

  /** 注册事件监听（WebSocket 层订阅） */
  onEvent(listener: HostEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 获取状态信息 */
  getStatus(): { ok: boolean; version: string; maestroDetected: boolean; sessions: number; uptimeMs: number } & ComponentVersions {
    const uptimeMs = Date.now() - this._startedAt;
    return {
      ok: true,
      version: "0.1.0",
      maestroDetected: this.maestroDetected,
      ...this.componentVersions,
      sessions: this.sessions.size,
      uptimeMs,
    };
  }

  /** 启动 Maestro 状态轮询 */
  async startMaestroPoll(intervalMs = 5000): Promise<void> {
    if (this.maestroPollTimer) return; // 重复启动防护
    // 启动时探测一次组件版本（内部带缓存，失败字段留空由 UI 显示待接入）
    this.componentVersions = await this.versionDetector.detect();
    await this.refreshMaestroState();
    await this.pollTelemetry();
    this.maestroPollTimer = setInterval(() => {
      void this.refreshMaestroState();
      void this.pollTelemetry();
    }, intervalMs);
  }

  /** 立即读取一次 Maestro 状态（HTTP 路由用） */
  async readMaestroStateNow() {
    return this.maestroReader.readState();
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
    // P2-4：同一会话（continue 同一 sessionFile 时 id 相同）重复 open 时，
    // 先释放旧 runner（否则旧实例仍在订阅 SDK 事件并广播，且 runtime 常驻内存），再登记新实例。
    const existing = this.sessions.get(runner.id);
    if (existing && existing !== runner) {
      await existing.dispose();
    }
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

  /** 刷新 Maestro 状态（仅状态变化时推送） */
  private async refreshMaestroState(): Promise<void> {
    try {
      // P3-1：接线 detectMaestro，使 getStatus().maestroDetected 反映真实检测结果
      this.maestroDetected = await this.maestroReader.detectMaestro();
    } catch {
      // ignore
    }
    try {
      const state = await this.maestroReader.readStateChanged();
      if (state === null) return;
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