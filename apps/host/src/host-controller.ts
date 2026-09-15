import type { HostEvent, SessionSnapshot, ExtensionUiResponse } from "@maestro-mobile/shared";
import type { DesktopPluginTarget } from "@maestro-mobile/shared";
import type { RuntimeFactory, SessionRunner, OpenSessionRequest, HostEventListener } from "./types.js";
import { SdkSessionRunner } from "./session-runner.js";
import { MaestroStateReader } from "./maestro-state.js";
import { LiveSessionsService } from "./live-sessions.js";
import { WorkspaceTelemetryReader } from "./workspace-telemetry.js";
import { monitorStateEvent } from "./monitor-projection.js";
import { MonitorReadService } from "./application/monitor-read-service.js";
import { isMonitorOwner } from "./application/session-visibility.js";
import { SessionDirectory, type SessionTargetIdentity } from "./control/SessionDirectory.js";
import { SessionCommandService } from "./application/session-command-service.js";
import { SessionQueryService } from "./application/session-query-service.js";
import { MonitorQueryService } from "./application/monitor-query-service.js";
import { ApplicationCommandRouter, type SessionOperation } from "./application/application-command-router.js";
import { DesktopPluginRegistry } from "./plugin/desktop-plugin-registry.js";
import { DesktopControlGatewayService } from "./control/desktop-control-gateway.js";
import { readSettingsOverview, updateSettingsJson } from "./maestro-settings.js";
export { isMonitorOwner } from "./application/session-visibility.js";
import { VersionDetector, type ComponentVersions } from "./version-detector.js";
import { EventLog } from "./event-log.js";
import { readFileSync } from "node:fs";
import { normalize, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceOwner } from "./workspace-telemetry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let hostPackageVersion = "0.4.0";
try {
  const rawPkg = readFileSync(resolve(__dirname, "../package.json"), "utf8");
  const parsed = JSON.parse(rawPkg) as { version?: string };
  if (parsed.version) hostPackageVersion = parsed.version;
} catch {}

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
  private readonly monitorReadService: MonitorReadService;
  private readonly sessionDirectory = new SessionDirectory();
  private readonly sessionTargets = new Map<string, SessionTargetIdentity>();
  private readonly sessionCommandService: SessionCommandService;
  private readonly desktopPluginRegistry = new DesktopPluginRegistry();
  private readonly desktopControlGateway: DesktopControlGatewayService;
  private readonly sessionQueryService: SessionQueryService;
  private readonly applicationRouter: ApplicationCommandRouter;
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
    this.monitorReadService = new MonitorReadService(() => this.telemetryReader.read());
    this.desktopControlGateway = new DesktopControlGatewayService(this.desktopPluginRegistry);
    this.sessionCommandService = new SessionCommandService(this.sessionDirectory, this.desktopControlGateway);
    this.sessionQueryService = new SessionQueryService(
      this.runtimeFactory,
      this.sessionDirectory,
      (sessionId) => this.sessionDirectory.list().find((target) => target.identity.sessionId === sessionId)?.presentation,
    );
    this.applicationRouter = new ApplicationCommandRouter(
      this.sessionCommandService,
      this.sessionQueryService,
      new MonitorQueryService(this.monitorReadService),
      {
        openSession: (request) => this.openSession(request),
        closeSession: (sessionId) => this.closeSession(sessionId),
        respondToExtensionUi: (sessionId, requestId, response) => this.respondToExtensionUi(sessionId, requestId, response),
        sessionOperation: (operation) => this.runSessionOperation(operation),
        readMaestroState: () => this.readMaestroStateNow(),
        readSettings: () => readSettingsOverview(),
        updateSettings: (patch) => updateSettingsJson(patch),
      },
    );
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

  get directory(): SessionDirectory {
    return this.sessionDirectory;
  }

  get application(): ApplicationCommandRouter {
    return this.applicationRouter;
  }

  get desktopPlugins(): DesktopPluginRegistry {
    return this.desktopPluginRegistry;
  }

  get desktopGateway(): DesktopControlGatewayService {
    return this.desktopControlGateway;
  }

  registerDesktopTarget(target: DesktopPluginTarget): void {
    const registration = this.desktopPluginRegistry.resolve(target);
    if (!registration) return;
    this.sessionDirectory.registerDesktopTarget(target, registration.capabilities);
  }

  getSessionTarget(sessionId: string): SessionTargetIdentity | undefined {
    const mapped = this.sessionTargets.get(sessionId);
    if (mapped) return { ...mapped };
    const matches = this.sessionDirectory.list().filter((target) => target.identity.sessionId === sessionId);
    return matches.length === 1 ? { ...matches[0].identity } : undefined;
  }

  unregisterDesktopTarget(target: DesktopPluginTarget): void {
    // A reconnect may replace the registration before the old socket closes.
    if (this.desktopPluginRegistry.resolve(target)) return;
    this.sessionDirectory.unregister(target);
  }


  async listLiveSessions() {
    return this.liveSessions.list();
  }

  /** 读取 workspace telemetry（owner 状态，Monitor/Teammate 合同） */
  async readTelemetry() {
    return this.telemetryReader.read();
  }

  /** 读取服务端统一 Monitor projection（查询与推送共用）。 */
  async readMonitorState() {
    return (await this.monitorReadService.read()).state;
  }

  /** 读取 Monitor projection 及稳定 revision，供 transport 适配层使用。 */
  async readMonitorSnapshot() {
    return this.monitorReadService.read();
  }

  /**
   * 查询匹配该会话的当前活跃桌面 TUI 窗口：
   * - 必须 heartbeat 新鲜且 cwd 一致；
   * - 默认过滤处于 Monitor 控制模式下的窗口（allowMonitor=false），防止业务消息错投进监控窗口；
   * - 若提供了 sessionId，严格按 sessionId 匹配；
   * - 若未提供 sessionId，仅在同 cwd 仅有唯一活跃非监控窗口时返回，多窗口歧义时返回 undefined 防止误投。
   */
  async findActiveOwnerForSession(
    cwd: string,
    sessionId?: string,
    options?: { allowMonitor?: boolean },
  ): Promise<WorkspaceOwner | undefined> {
    try {
      const t = await this.telemetryReader.read();
      const normCwd = normalize(cwd);
      let aliveOwners = t.owners.filter((o) => o.alive && normalize(o.normalizedCwd) === normCwd);
      if (aliveOwners.length === 0) return undefined;

      // 默认过滤 Monitor 监督窗口，业务 prompt 消息绝不注入监控会话
      if (!options?.allowMonitor) {
        aliveOwners = aliveOwners.filter((o) => !isMonitorOwner(o));
      }

      if (sessionId) {
        return aliveOwners.find((o) => o.sessionId === sessionId);
      }

      // 未指定 sessionId 时的安全兜底：仅当存在唯一活跃窗口时才返回，多个窗口存在歧义时绝不盲猜
      return aliveOwners.length === 1 ? aliveOwners[0] : undefined;
    } catch {
      return undefined;
    }
  }

  /** 查询匹配该 cwd 的当前活跃桌面 TUI 窗口（兼容别名，内部转调 findActiveOwnerForSession） */
  async findActiveOwnerForCwd(cwd: string, sessionId?: string, options?: { allowMonitor?: boolean }): Promise<WorkspaceOwner | undefined> {
    return this.findActiveOwnerForSession(cwd, sessionId, options);
  }

  /** 轮询统一 Monitor Read Service，状态变化时推送同一份 projection */
  async pollTelemetry(): Promise<void> {
    if (this.telemetryInFlight) return;
    this.telemetryInFlight = true;
    try {
      const snapshot = await this.monitorReadService.read();
      if (snapshot.stableKey === this.telemetryCache) return;
      this.telemetryCache = snapshot.stableKey;
      this.emitToListeners(this.eventLog.record(monitorStateEvent(snapshot.state)));
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
      version: hostPackageVersion,
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
      const oldTarget = this.sessionTargets.get(runner.id);
      if (oldTarget) this.sessionDirectory.unregister(oldTarget);
      await existing.dispose();
    }
    this.sessions.set(runner.id, runner);
    this.sessionTargets.set(runner.id, this.sessionDirectory.registerHostRunner(runner));
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

  private async runSessionOperation(operation: SessionOperation): Promise<unknown> {
    const entry = this.sessionDirectory.resolve(operation.target);
    const runner = entry?.runner;
    if (!runner) throw new Error("target_unavailable");
    switch (operation.kind) {
      case "load_more_history": return runner.loadMoreHistory(operation.count);
      case "search_history": return runner.searchHistory(operation.keyword, operation.maxResults, operation.previewLength);
      case "list_models": return typeof runner.listModels === "function" ? runner.listModels() : { ok: false, error: "unsupported_command" };
      case "list_skills": return typeof runner.listLoadedSkills === "function" ? runner.listLoadedSkills() : { ok: false, error: "unsupported_command" };
      case "set_model": return typeof runner.setModel === "function" ? runner.setModel(operation.modelId) : { ok: false, error: "unsupported_command" };
      case "set_thinking": return typeof runner.setThinking === "function" ? runner.setThinking(operation.level) : { ok: false, error: "unsupported_command" };
      case "compact": return typeof runner.compact === "function" ? runner.compact(operation.customInstructions) : { ok: false, error: "unsupported_command" };
      case "rename_session": return typeof runner.renameSession === "function" ? runner.renameSession(operation.name) : { ok: false, error: "unsupported_command" };
    }
  }

  /** 关闭会话 */
  async closeSession(sessionId: string): Promise<boolean> {
    const runner = this.sessions.get(sessionId);
    if (!runner) return false;
    this.sessions.delete(sessionId);
    const target = this.sessionTargets.get(sessionId);
    if (target) {
      this.sessionDirectory.unregister(target);
      this.sessionTargets.delete(sessionId);
    }
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
    this.sessionTargets.clear();
    for (const target of this.sessionDirectory.list()) this.sessionDirectory.unregister(target.identity);
    this.desktopPluginRegistry.clear();
    this.listeners.clear();
  }
}
