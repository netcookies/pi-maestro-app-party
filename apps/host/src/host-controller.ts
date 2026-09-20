import type { HostEvent, SessionSnapshot, ExtensionUiResponse, DesktopAskRequest, DesktopPluginModel, DesktopPluginRuntimeStatus, DesktopPluginSessionSummary, SessionSummaryPatch } from "@maestro-mobile/shared";
import type { DesktopPluginTarget } from "@maestro-mobile/shared";
import type { RuntimeFactory, SessionRunner, OpenSessionRequest, HostEventListener } from "./types.js";
import { SdkSessionRunner } from "./session-runner.js";
import { MaestroStateReader } from "./maestro-state.js";
import { WorkspaceTelemetryReader } from "./workspace-telemetry.js";
import { monitorStateEvent } from "./monitor-projection.js";
import { MonitorReadService } from "./application/monitor-read-service.js";
import { SessionDirectory, type SessionTargetIdentity } from "./control/SessionDirectory.js";
import { SessionCommandService } from "./application/session-command-service.js";
import { SessionQueryService } from "./application/session-query-service.js";
import { MonitorQueryService } from "./application/monitor-query-service.js";
import { ApplicationCommandRouter, type SessionOperation } from "./application/application-command-router.js";
import { DesktopBrokerProjectedRegistry } from "./plugin/desktop-broker-host-ipc.js";
import { DesktopControlGatewayService } from "./control/desktop-control-gateway.js";
import { readSettingsOverview, updateSettingsJson } from "./maestro-settings.js";
import { VersionDetector, type ComponentVersions } from "./version-detector.js";
import { EventLog } from "./event-log.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function targetKey(target: DesktopPluginTarget): string {
  return [target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration].join("\u0000");
}

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
  private readonly telemetryReader: WorkspaceTelemetryReader;
  private readonly monitorReadService: MonitorReadService;
  private readonly sessionDirectory = new SessionDirectory();
  private readonly sessionTargets = new Map<string, SessionTargetIdentity>();
  private readonly pendingDesktopModels = new Map<string, DesktopPluginModel>();
  private readonly pendingDesktopThinking = new Map<string, string>();
  private readonly desktopReaderAttachInFlight = new Map<string, Promise<void>>();
  private readonly detachedReaderDisposals = new Set<Promise<void>>();
  private readonly pendingDesktopAsks = new Map<string, { target: DesktopPluginTarget; request: DesktopAskRequest; event: Extract<HostEvent, { type: "extension_ui_request" }>; timer: ReturnType<typeof setTimeout> }>();
  private readonly projectedDesktopTargets = new Map<string, DesktopPluginTarget>();
  private readonly sessionCommandService: SessionCommandService;
  private readonly desktopPluginRegistry: DesktopBrokerProjectedRegistry;
  private desktopBrokerLinkHealth: () => boolean = () => this.desktopPluginRegistry.isValid;
  private desktopBrokerFlapping: () => boolean = () => false;
  private readonly desktopControlGateway: DesktopControlGatewayService;
  private readonly sessionQueryService: SessionQueryService;
  private readonly applicationRouter: ApplicationCommandRouter;
  private telemetryCache: string | null = null;
  private telemetryInFlight = false;
  private disposed = false;
  private readonly emitToListeners: (event: HostEvent) => void;
  private maestroPollTimer: ReturnType<typeof setInterval> | null = null;
  private maestroDetected = false;
  private readonly versionDetector = new VersionDetector();
  private componentVersions: ComponentVersions = {};
  private _startedAt = Date.now();

  constructor(
    private readonly runtimeFactory: RuntimeFactory,
    maestroReader?: MaestroStateReader,
    desktopRegistry?: DesktopBrokerProjectedRegistry,
  ) {
    this.desktopPluginRegistry = desktopRegistry ?? new DesktopBrokerProjectedRegistry();
    this.maestroReader = maestroReader ?? new MaestroStateReader();
    this.telemetryReader = new WorkspaceTelemetryReader();
    this.monitorReadService = new MonitorReadService(() => this.telemetryReader.read());
    this.desktopControlGateway = new DesktopControlGatewayService(this.desktopPluginRegistry);
    this.sessionCommandService = new SessionCommandService(this.sessionDirectory, this.desktopControlGateway);
    this.sessionQueryService = new SessionQueryService(
      this.runtimeFactory,
      this.sessionDirectory,
      (sessionId) => {
        const target = this.getSessionTarget(sessionId);
        return target ? this.sessionDirectory.resolve(target)?.presentation : undefined;
      },
      Date.now,
      () => this.monitorReadService.read().then((snapshot) => snapshot.state),
      (sessionId) => {
        const target = this.getSessionTarget(sessionId);
        return target ? this.sessionDirectory.resolve(target) : undefined;
      },
    );
    this.applicationRouter = new ApplicationCommandRouter(
      this.sessionCommandService,
      this.sessionQueryService,
      new MonitorQueryService(this.monitorReadService),
      {
        openSession: (request) => this.openSession(request),
        closeSession: (sessionId, target) => this.closeSession(sessionId, target),
        respondToExtensionUi: (sessionId, requestId, response, target) => this.respondToExtensionUi(sessionId, requestId, response, target),
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

  get nextEventSequence(): number {
    return this.eventLog.nextSequence;
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

  get desktopPlugins(): DesktopBrokerProjectedRegistry {
    return this.desktopPluginRegistry;
  }

  setDesktopBrokerLinkHealth(reader: () => boolean, flappingReader: () => boolean = () => false): void {
    this.desktopBrokerLinkHealth = reader;
    this.desktopBrokerFlapping = flappingReader;
  }

  getDesktopCurrentStatus(target?: DesktopPluginTarget): {
    broker: { connected: boolean; projectionValid: boolean; brokerInstanceId?: string; revision: number; flapping: boolean };
    targets: Array<{ target: DesktopPluginTarget; runtimeStatus: DesktopPluginRuntimeStatus; thinkingLevel?: string; summary?: DesktopPluginSessionSummary }>;
  } {
    const targets = this.desktopPluginRegistry.list()
      .filter((registration) => !target || targetKey(registration.target) === targetKey(target))
      .map((registration) => ({
        target: { ...registration.target },
        runtimeStatus: registration.runtimeStatus,
        ...(registration.thinkingLevel ? { thinkingLevel: registration.thinkingLevel } : {}),
        ...(registration.summary ? { summary: structuredClone(registration.summary) } : {}),
      }));
    return {
      broker: {
        connected: this.desktopBrokerLinkHealth(),
        projectionValid: this.desktopPluginRegistry.isValid,
        flapping: this.desktopBrokerFlapping(),
        ...(this.desktopPluginRegistry.epoch ? { brokerInstanceId: this.desktopPluginRegistry.epoch } : {}),
        revision: this.desktopPluginRegistry.revision,
      },
      targets,
    };
  }

  applyDesktopProjection(records: readonly {
    target: DesktopPluginTarget;
    capabilities: readonly import("@maestro-mobile/shared").DesktopPluginCapability[];
    model?: DesktopPluginModel;
    thinkingLevel?: string;
    sessionFile?: string;
    runtimeStatus: DesktopPluginRuntimeStatus;
    summary?: DesktopPluginSessionSummary;
  }[]): void {
    const nextTargets = new Map(records.map((record) => [targetKey(record.target), record.target]));
    for (const previous of this.projectedDesktopTargets.values()) {
      const key = targetKey(previous);
      if (!nextTargets.has(key)) {
        this.projectedDesktopTargets.delete(key);
        this.unregisterDesktopTarget(previous);
      }
    }
    for (const record of records) {
      const key = targetKey(record.target);
      const current = this.sessionDirectory.resolve(record.target);
      const capabilitiesChanged = JSON.stringify(current?.capabilities.map((capability) => capability === "ask" ? "ask-user-question" : capability).sort())
        !== JSON.stringify([...record.capabilities].sort());
      const thinkingChanged = current?.thinkingLevel !== record.thinkingLevel;
      const modelChanged = JSON.stringify(current?.model) !== JSON.stringify(record.model);
      if (!this.projectedDesktopTargets.has(key) || current?.sessionFile !== record.sessionFile || capabilitiesChanged) {
        this.registerDesktopTarget(record.target);
      }
      this.projectedDesktopTargets.set(key, { ...record.target });
      if (modelChanged) {
        this.pendingDesktopModels.delete(key);
        this.sessionDirectory.updateDesktopModel(record.target, record.model as DesktopPluginModel);
        this.sessionDirectory.resolve(record.target)?.runner?.syncExternalModel?.(record.model as DesktopPluginModel);
      }
      if (thinkingChanged) this.syncDesktopThinking(record.target, record.thinkingLevel, true);
      if (record.summary) this.syncDesktopSessionSummary(record.target, record.summary);
      else this.publishDesktopSummary(record.target, { reset: true, runtimeStatus: record.runtimeStatus, activeSince: null });
      this.ensureDesktopReader(record.target);
    }
  }

  private ensureDesktopReader(target: DesktopPluginTarget): void {
    if (this.disposed) return;
    const key = targetKey(target);
    if (this.desktopReaderAttachInFlight.has(key)) return;
    const task = this.attachDesktopReader(target).finally(() => {
      if (this.desktopReaderAttachInFlight.get(key) === task) this.desktopReaderAttachInFlight.delete(key);
    });
    this.desktopReaderAttachInFlight.set(key, task);
  }

  private async attachDesktopReader(target: DesktopPluginTarget): Promise<void> {
    if (this.disposed) return;
    const entry = this.sessionDirectory.resolve(target);
    if (!entry || entry.kind !== "desktop" || entry.runner || !entry.sessionFile || !existsSync(entry.sessionFile)) return;
    try {
      await this.openSession({ cwd: target.normalizedCwd, mode: "create", target });
    } catch {
      return;
    }
    if (this.disposed) {
      const runner = this.sessionDirectory.resolve(target)?.runner;
      if (runner) await runner.dispose();
      return;
    }
    const runner = this.sessionDirectory.resolve(target)?.runner;
    if (!runner) return;
    for (const item of runner.snapshot().timeline) {
      this.emitToListeners(this.eventLog.record({ type: "timeline_item", sessionId: target.sessionId, item, target }));
    }
    this.emitToListeners(this.eventLog.record({ type: "session_updated", session: runner.state, target }));
  }

  get desktopGateway(): DesktopControlGatewayService {
    return this.desktopControlGateway;
  }

  registerDesktopTarget(target: DesktopPluginTarget): void {
    const registration = this.desktopPluginRegistry.resolve(target);
    if (!registration) return;
    this.sessionDirectory.registerDesktopTarget(target, registration.capabilities, {
      sessionFile: registration.sessionFile,
      ...(registration.model ? { model: registration.model } : {}),
      ...(registration.thinkingLevel ? { thinkingLevel: registration.thinkingLevel } : {}),
    });
  }

  getSessionTarget(sessionId: string): SessionTargetIdentity | undefined {
    const mapped = this.sessionTargets.get(sessionId);
    // A mapping is established only by an exact registration/open operation. Once present it is
    // authoritative even when sibling endpoints share the same sessionId; ambiguity applies only
    // to legacy lookup before an exact endpoint has been selected.
    if (mapped && this.sessionDirectory.resolve(mapped)) return { ...mapped };
    if (mapped) this.sessionTargets.delete(sessionId);
    const matches = this.sessionDirectory.list().filter((target) => target.identity.sessionId === sessionId);
    const desktopTargets = matches.filter((target) => target.kind === "desktop");
    if (desktopTargets.length > 1) return undefined;
    return matches.length === 1 ? { ...matches[0].identity } : undefined;
  }

  syncDesktopModel(target: DesktopPluginTarget, model: DesktopPluginModel): void {
    // The event may arrive before Mobile opens the session: remember it per exact target.
    this.pendingDesktopModels.set(targetKey(target), model);
    this.sessionDirectory.updateDesktopModel(target, model);
    this.sessionDirectory.resolve(target)?.runner?.syncExternalModel?.(model);
  }

  syncDesktopThinking(target: DesktopPluginTarget, level: string | undefined, force = false): void {
    const current = this.sessionDirectory.resolve(target);
    if (!current || (!force && current.thinkingLevel === level)) return;
    const key = targetKey(target);
    if (level === undefined) this.pendingDesktopThinking.delete(key);
    else this.pendingDesktopThinking.set(key, level);
    this.sessionDirectory.updateDesktopThinking(target, level);
    if (current.runner) {
      current.runner.syncExternalThinking?.(level);
      return;
    }
    void this.sessionQueryService.snapshot(target).then((snapshot) => {
      const latest = this.sessionDirectory.resolve(target);
      if (!snapshot.ok || !snapshot.value || !latest || latest.runner || latest.thinkingLevel !== level) return;
      this.emitToListeners(this.eventLog.record({ type: "session_updated", session: snapshot.value.session, target }));
    });
  }

  syncDesktopRuntimeStatus(target: DesktopPluginTarget, runtimeStatus: DesktopPluginRuntimeStatus): void {
    const current = this.sessionDirectory.resolve(target);
    if (!current || current.runtimeStatus === runtimeStatus) return;
    const now = new Date().toISOString();
    const patch: SessionSummaryPatch = runtimeStatus === "running"
      ? { runtimeStatus, activeSince: current.activeSince ?? now, lastActivityAt: now }
      : { runtimeStatus, activeSince: null, lastActivityAt: now };
    this.publishDesktopSummary(target, patch);
  }

  syncDesktopSessionSummary(target: DesktopPluginTarget, summary: DesktopPluginSessionSummary): void {
    this.publishDesktopSummary(target, summary);
  }

  onDesktopAskRequest(target: DesktopPluginTarget, request: DesktopAskRequest): void {
    if (this.disposed || request.deadlineAt <= Date.now() || !this.sessionDirectory.resolve(target, "ask")) return;
    const id = JSON.stringify([targetKey(target), request.requestId]);
    if (this.pendingDesktopAsks.has(id)) return;
    const timer = setTimeout(() => this.clearDesktopAsk(id), request.deadlineAt - Date.now());
    timer.unref?.();
    const event = this.eventLog.record({
      type: "extension_ui_request",
      sessionId: target.sessionId,
      target,
      request: {
        id,
        sessionId: target.sessionId,
        method: "editor",
        title: "Ask",
        questions: request.questions,
        timeout: request.deadlineAt - Date.now(),
      },
    }) as Extract<HostEvent, { type: "extension_ui_request" }>;
    this.pendingDesktopAsks.set(id, { target: { ...target }, request, event, timer });
    this.emitToListeners(event);
  }

  pendingDesktopAskEvents(): HostEvent[] {
    return [...this.pendingDesktopAsks.values()]
      .filter(({ request }) => request.deadlineAt > Date.now())
      .map(({ event, request }) => ({ ...event, request: { ...event.request, timeout: Math.max(1, request.deadlineAt - Date.now()) } }));
  }

  private clearDesktopAsk(id: string): void {
    const pending = this.pendingDesktopAsks.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDesktopAsks.delete(id);
    if (!this.disposed) this.emitToListeners(this.eventLog.record({ type: "extension_ui_cleared", sessionId: pending.target.sessionId, requestId: id, target: pending.target }));
  }

  private publishDesktopSummary(target: DesktopPluginTarget, patch: SessionSummaryPatch): void {
    const update = this.sessionDirectory.updateDesktopSummary(target, patch);
    if (!update) return;
    this.emitToListeners(this.eventLog.record({
      type: "session_summary_updated",
      target: { ...update.target.identity },
      patch: update.patch,
      revision: update.revision,
    }));
  }

  unregisterDesktopTarget(target: DesktopPluginTarget): void {
    // A reconnect may replace the registration before the old socket closes.
    if (this.desktopPluginRegistry.resolve(target)) return;
    const entry = this.sessionDirectory.resolve(target);
    if (!entry) return;
    for (const [id, pending] of this.pendingDesktopAsks) {
      if (targetKey(pending.target) === targetKey(target)) this.clearDesktopAsk(id);
    }
    this.publishDesktopSummary(target, { reset: true, runtimeStatus: "sleeping", activeSince: null, lastActivityAt: new Date().toISOString() });
    const runner = entry.runner;
    const sessionId = target.sessionId;
    this.pendingDesktopModels.delete(targetKey(target));
    this.pendingDesktopThinking.delete(targetKey(target));
    this.sessionDirectory.unregister(target);
    if (!runner) return;

    // A reader created for an exact Desktop target must not silently become Host-owned when
    // that endpoint disappears. Dispose it and require a new explicit open for another target.
    if (this.sessions.get(sessionId) === runner) {
      this.sessions.delete(sessionId);
      if (targetKey(this.sessionTargets.get(sessionId) ?? target) === targetKey(target)) this.sessionTargets.delete(sessionId);
    }
    const task = runner.dispose().catch((error: unknown) => {
      console.error("[maestro-mobile] desktop reader disposal failed:", error);
    });
    this.detachedReaderDisposals.add(task);
    void task.finally(() => this.detachedReaderDisposals.delete(task));
  }
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
  async openSession(request: OpenSessionRequest): Promise<{ id: string }> {
    const requestedEntry = request.target ? this.sessionDirectory.resolve(request.target) : undefined;
    if (request.target && !requestedEntry) throw new Error("target_unavailable");
    if (request.target && resolve(request.target.normalizedCwd) !== resolve(request.cwd)) {
      throw new Error("target_mismatch");
    }
    // Reopening a list row that already owns a reader must not replace that reader or rebind
    // the session by inference. The exact server-issued target is already the desired endpoint.
    if (request.target && requestedEntry?.runner) {
      const openedFile = requestedEntry.runner.state.sessionFile;
      if (request.sessionFile && (!openedFile || resolve(openedFile) !== resolve(request.sessionFile))) {
        throw new Error("target_mismatch");
      }
      this.sessions.set(request.target.sessionId, requestedEntry.runner);
      this.sessionTargets.set(request.target.sessionId, request.target);
      return requestedEntry.runner;
    }

    const projectedSessionFile = requestedEntry?.sessionFile;
    if (request.target && request.sessionFile && (!projectedSessionFile || resolve(request.sessionFile) !== resolve(projectedSessionFile))) {
      throw new Error("target_mismatch");
    }
    const sessionFile = request.target ? projectedSessionFile : request.sessionFile;
    if (request.target && requestedEntry?.kind === "desktop" && (!sessionFile || !existsSync(sessionFile))) {
      // A live Plugin may advertise its future JSONL path before the first record creates the file.
      // Keep the exact target selectable and controllable without opening a new Host-owned session.
      this.sessionTargets.set(request.target.sessionId, request.target);
      return { id: request.target.sessionId };
    }

    const pendingEvents: HostEvent[] = [];
    let openedTarget = request.target;
    const runner = await SdkSessionRunner.open(this.runtimeFactory, {
      ...request,
      ...(sessionFile ? { sessionFile } : {}),
    }, (event) => {
      if (!openedTarget) {
        pendingEvents.push(event);
        return;
      }
      this.emitToListeners(this.eventLog.record(
        event.type === "session_updated" || event.type === "timeline_item" || event.type === "timeline_delta"
          || event.type === "raw_event" || event.type === "command_error" || event.type === "extension_ui_request" || event.type === "extension_ui_cleared"
          ? { ...event, target: openedTarget }
          : event,
      ));
    });
    let explicitTarget: SessionTargetIdentity | undefined;
    if (request.target) {
      if (runner.id !== request.target.sessionId || resolve(runner.state.cwd) !== resolve(request.target.normalizedCwd)) {
        await runner.dispose();
        throw new Error("target_mismatch");
      }
      if (!this.sessionDirectory.attachRunner(request.target, runner)) {
        await runner.dispose();
        throw new Error("target_unavailable");
      }
      explicitTarget = request.target;
    }

    // P2-4：同一会话（continue 同一 sessionFile 时 id 相同）重复 open 时，
    // 先释放旧 runner（否则旧实例仍在订阅 SDK 事件并广播，且 runtime 常驻内存），再登记新实例。
    const existing = this.sessions.get(runner.id);
    if (existing && existing !== runner) {
      for (const entry of this.sessionDirectory.list().filter((candidate) => candidate.identity.sessionId === runner.id && candidate.runner === existing)) {
        if (entry.kind === "desktop") this.sessionDirectory.detachRunner(entry.identity, existing);
        else this.sessionDirectory.unregister(entry.identity);
      }
      this.sessionTargets.delete(runner.id);
      await existing.dispose();
    }
    this.sessions.set(runner.id, runner);
    const target = explicitTarget ?? this.sessionDirectory.registerHostRunner(runner);
    openedTarget = target;
    for (const event of pendingEvents) {
      this.emitToListeners(this.eventLog.record(
        event.type === "session_updated" || event.type === "timeline_item" || event.type === "timeline_delta"
          || event.type === "raw_event" || event.type === "command_error" || event.type === "extension_ui_request" || event.type === "extension_ui_cleared"
          ? { ...event, target }
          : event,
      ));
    }
    this.sessionTargets.set(runner.id, target);
    const pendingModel = this.pendingDesktopModels.get(targetKey(target));
    if (pendingModel) runner.syncExternalModel?.(pendingModel);
    const pendingThinking = this.pendingDesktopThinking.get(targetKey(target));
    if (pendingThinking) runner.syncExternalThinking?.(pendingThinking);
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
    if (!runner) {
      if (entry?.kind !== "desktop") throw new Error("target_unavailable");
      switch (operation.kind) {
        case "load_more_history": return { items: [], hasMore: false, totalEntries: 0, historyAvailable: false };
        case "search_history": return { matches: [], totalEntries: 0, historyAvailable: false };
        case "list_models":
        case "list_skills": return [];
        default: throw new Error("target_unavailable");
      }
    }
    switch (operation.kind) {
      case "load_more_history": return runner.loadMoreHistory(operation.count);
      case "search_history": return runner.searchHistory(operation.keyword, operation.maxResults, operation.previewLength);
      case "list_models": return typeof runner.listModels === "function" ? runner.listModels() : { ok: false, error: "unsupported_command" };
      case "list_skills": return typeof runner.listLoadedSkills === "function" ? runner.listLoadedSkills() : { ok: false, error: "unsupported_command" };
      case "set_model": return typeof runner.setModel === "function" ? runner.setModel(operation.modelId, operation.provider) : { ok: false, error: "unsupported_command" };
      case "compact": return typeof runner.compact === "function" ? runner.compact(operation.customInstructions) : { ok: false, error: "unsupported_command" };
      case "rename_session": return typeof runner.renameSession === "function" ? runner.renameSession(operation.name) : { ok: false, error: "unsupported_command" };
    }
  }

  /** 关闭会话 */
  async closeSession(sessionId: string, target?: SessionTargetIdentity): Promise<boolean> {
    const resolvedTarget = target ?? this.getSessionTarget(sessionId);
    if (!resolvedTarget || resolvedTarget.sessionId !== sessionId) return false;
    const entry = this.sessionDirectory.resolve(resolvedTarget);
    const runner = entry?.runner;
    if (!runner || this.sessions.get(sessionId) !== runner) return false;
    this.sessions.delete(sessionId);
    const attachedEntries = this.sessionDirectory.list()
      .filter((entry) => entry.identity.sessionId === sessionId && entry.runner === runner);
    for (const entry of attachedEntries) {
      if (entry.kind === "desktop") this.sessionDirectory.detachRunner(entry.identity, runner);
      else this.sessionDirectory.unregister(entry.identity);
    }
    this.sessionTargets.delete(sessionId);
    await runner.dispose();
    return true;
  }

  /** 处理 extension_ui_response */
  async respondToExtensionUi(sessionId: string, requestId: string, response: ExtensionUiResponse, target?: SessionTargetIdentity): Promise<boolean> {
    const resolvedTarget = target ?? this.getSessionTarget(sessionId);
    if (!resolvedTarget || resolvedTarget.sessionId !== sessionId) return false;
    const entry = this.sessionDirectory.resolve(resolvedTarget);
    if (entry?.kind === "desktop") {
      const pending = this.pendingDesktopAsks.get(requestId);
      if (!pending || targetKey(pending.target) !== targetKey(resolvedTarget) || pending.request.deadlineAt <= Date.now()) return false;
      const result = await this.desktopControlGateway.answerAsk(resolvedTarget, pending.request.requestId, pending.request.toolCallId, response);
      if (result.status !== "accepted") return false;
      this.clearDesktopAsk(requestId);
      return true;
    }
    const runner = entry?.runner;
    return !!runner && this.sessions.get(sessionId) === runner && runner.respondToExtensionUi(requestId, response);
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
    this.disposed = true;
    this.stopMaestroPoll();
    for (const pending of this.pendingDesktopAsks.values()) clearTimeout(pending.timer);
    this.pendingDesktopAsks.clear();
    await Promise.allSettled([...this.desktopReaderAttachInFlight.values(), ...this.detachedReaderDisposals]);
    for (const runner of this.sessions.values()) {
      await runner.dispose();
    }
    this.sessions.clear();
    this.sessionTargets.clear();
    this.desktopReaderAttachInFlight.clear();
    this.projectedDesktopTargets.clear();
    for (const target of this.sessionDirectory.list()) this.sessionDirectory.unregister(target.identity);
    this.desktopPluginRegistry.clear();
    this.listeners.clear();
  }
}
