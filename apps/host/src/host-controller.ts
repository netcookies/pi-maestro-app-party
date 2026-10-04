import type { HostEvent, SessionSnapshot, ExtensionUiResponse, DesktopAskRequest, DesktopAskResponse, DesktopPluginModel, DesktopPluginRuntimeStatus, DesktopPluginSessionSummary, DesktopPluginExecutionSummary, SessionExecutionSummary, SessionSummaryPatch, TimelineItem, DesktopPlanRequest, DesktopPlanResponse } from "@maestro-mobile/shared";

import type { DesktopPluginTarget } from "@maestro-mobile/shared";
import type { SessionCatalog, HostEventListener } from "./types.js";
import { MaestroStateReader } from "./maestro-state.js";
import { WorkspaceTelemetryReader } from "./workspace-telemetry.js";
import { executionProjectionEvents, monitorStateEvent } from "./monitor-projection.js";
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
import { searchInJsonl } from "./jsonl-pager.js";
import { JsonlTailWatcher } from "./jsonl-tail-watcher.js";
import { EventLog } from "./event-log.js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";

import { NotificationOutbox } from "./notifications/notification-outbox.js";
import { NotificationConfigStore } from "./notifications/notification-config.js";
import { NotificationDispatcher } from "./notifications/notification-dispatcher.js";
import { notificationProviders } from "./notifications/providers/index.js";
import { notificationEventFromHostEvent } from "./notifications/notification-normalizer.js";

function targetKey(target: DesktopPluginTarget): string {
  return [target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration].join("\u0000");
}

function notificationSessionLabel(sessionId: string): string {
  return sessionId.length > 12 ? sessionId.slice(0, 8) : sessionId;
}

function planKey(target: DesktopPluginTarget, requestId: string, kind: DesktopPlanRequest["kind"]): string {
  return JSON.stringify([targetKey(target), requestId, kind]);
}

function timelineContentKey(item: TimelineItem): string {
  const { id: _id, ...content } = item;
  return JSON.stringify(content);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// 读取失败时的占位：不能用具体版本号，否则发版后会谎报旧版本（见 release 契约版本漂移）。
let hostPackageVersion = "0.0.0";
try {
  const rawPkg = readFileSync(resolve(__dirname, "../package.json"), "utf8");
  const parsed = JSON.parse(rawPkg) as { version?: string };
  if (parsed.version) hostPackageVersion = parsed.version;
} catch {}

/**
 * HostController — 集中管理所有会话 + Maestro 状态 + 事件分发
 *
 * 职责：
 * - 管理 Desktop target 的 JSONL reader 生命周期
 * - 注册 HostEventListener 事件监听（给 WebSocket 广播用）
 * - 调度 MaestroStateReader 定期读取
 * - 处理 client commands
 */
export class HostController {
  private readonly readerTargets = new Set<string>();

  private readonly eventLog = new EventLog();
  private readonly listeners = new Set<HostEventListener>();
  private readonly maestroReader: MaestroStateReader;
  private readonly telemetryReader: WorkspaceTelemetryReader;
  private readonly monitorReadService: MonitorReadService;
  private readonly sessionDirectory = new SessionDirectory();

  private readonly pendingDesktopModels = new Map<string, DesktopPluginModel>();
  private readonly pendingDesktopThinking = new Map<string, string>();
  private readonly detachedReaderDisposals = new Set<Promise<void>>();
  private readonly desktopTailWatchers = new Map<string, { sessionFile: string; watcher: JsonlTailWatcher }>();
  private readonly desktopReplayRefreshes = new Map<string, { timer: ReturnType<typeof setTimeout>; refreshing: boolean; replayQueued: boolean; pendingItems: TimelineItem[] }>();
  private readonly pendingDesktopAsks = new Map<string, { target: DesktopPluginTarget; request: DesktopAskRequest; event: Extract<HostEvent, { type: "extension_ui_request" }>; timer: ReturnType<typeof setTimeout> }>();
  private readonly pendingDesktopPlans = new Map<string, { target: DesktopPluginTarget; request: DesktopPlanRequest; timer: ReturnType<typeof setTimeout> }>();
  private readonly desktopRuntimeStatuses = new Map<string, DesktopPluginRuntimeStatus>();
  private readonly desktopExecutionSourceRevisions = new Map<string, number>();
  private readonly desktopExecutionEventRevisions = new Map<string, number>();
  private desktopExecutionRevision = 0;

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
  private readonly notificationConfig: NotificationConfigStore;
  private readonly notificationOutbox: NotificationOutbox;
  private readonly notificationDispatcher: NotificationDispatcher;
  private readonly notificationHostInstanceId = `${process.pid}-${Date.now()}`;
  private notificationSequence = 0;
  private readonly emitToListeners: (event: HostEvent) => void;
  private maestroPollTimer: ReturnType<typeof setInterval> | null = null;
  private maestroDetected = false;
  private readonly versionDetector = new VersionDetector();
  private componentVersions: ComponentVersions = {};
  private _startedAt = Date.now();

  constructor(
    private readonly sessionCatalog: SessionCatalog,
    maestroReader?: MaestroStateReader,
    desktopRegistry?: DesktopBrokerProjectedRegistry,
    notificationPaths?: { configPath?: string; outboxPath?: string },
  ) {
    this.desktopPluginRegistry = desktopRegistry ?? new DesktopBrokerProjectedRegistry();
    this.maestroReader = maestroReader ?? new MaestroStateReader();
    this.telemetryReader = new WorkspaceTelemetryReader();
    this.monitorReadService = new MonitorReadService(() => this.telemetryReader.read());
    this.desktopControlGateway = new DesktopControlGatewayService(this.desktopPluginRegistry);
    this.sessionCommandService = new SessionCommandService(this.sessionDirectory, this.desktopControlGateway);
    this.sessionQueryService = new SessionQueryService(
      this.sessionCatalog,
      this.sessionDirectory,
      undefined,
      Date.now,
      () => this.monitorReadService.read().then((snapshot) => snapshot.state),
      undefined,
    );
    this.applicationRouter = new ApplicationCommandRouter(
      this.sessionCommandService,
      this.sessionQueryService,
      new MonitorQueryService(this.monitorReadService),
      {
        respondToExtensionUi: (sessionId, requestId, response, target) => this.respondToExtensionUi(sessionId, requestId, response, target),
        sessionOperation: (operation) => this.runSessionOperation(operation),
        readMaestroState: () => this.readMaestroStateNow(),
        readSettings: () => readSettingsOverview(),
        updateSettings: (patch) => updateSettingsJson(patch),
        readNotificationConfig: () => this.readNotificationConfig(),
        updateNotificationConfig: (patch) => this.updateNotificationConfig(patch),
        testNotification: (providerId) => this.testNotification(providerId),
      },
    );
    const notificationRoot = process.env.VITEST ? join(tmpdir(), `maestro-notifications-test-${process.pid}-${randomUUID()}`) : join(homedir(), ".pi");
    this.notificationConfig = new NotificationConfigStore(notificationPaths?.configPath ?? join(notificationRoot, "maestro-mobile-notifications.json"));
    this.notificationOutbox = new NotificationOutbox(notificationPaths?.outboxPath ?? join(notificationRoot, "maestro-mobile-notification-outbox.json"));
    this.notificationDispatcher = new NotificationDispatcher(this.notificationOutbox, this.notificationConfig, notificationProviders);
    this.notificationDispatcher.start();
    this.emitToListeners = (event: HostEvent) => {
      const notification = notificationEventFromHostEvent(event, {
        hostInstanceId: this.notificationHostInstanceId,
        nextSequence: () => ++this.notificationSequence,
      });
      if (notification) {
        void this.notificationDispatcher.enqueue(notification).catch(() => undefined);
        const notificationFrame = this.eventLog.record({
          type: "notification_event",
          eventId: notification.eventId,
          kind: notification.kind,
          sessionId: notification.sessionId,
          title: notification.title,
          body: notification.body,
          occurredAt: notification.occurredAt,
          dedupeKey: notification.dedupeKey,
        });
        for (const listener of this.listeners) {
          try { listener(notificationFrame); } catch { /* ignore */ }
        }
      }
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
    return this.sessionDirectory.list().map((target) => target.identity.sessionId);
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
    executionSummary?: DesktopPluginExecutionSummary;
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
      this.syncDesktopRuntimeStatus(record.target, record.runtimeStatus);
      if (modelChanged) {
        this.pendingDesktopModels.delete(key);
        this.syncDesktopModel(record.target, record.model);
      }
      if (thinkingChanged) this.syncDesktopThinking(record.target, record.thinkingLevel, true);
      if (record.summary) this.syncDesktopSessionSummary(record.target, record.summary);
      else this.publishDesktopSummary(record.target, { reset: true, runtimeStatus: record.runtimeStatus, activeSince: null });
      if (record.executionSummary) this.syncDesktopExecutionSummary(record.target, record.executionSummary);
      else this.clearDesktopExecutionSummary(record.target);
    }
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
    this.ensureDesktopTailWatcher(target, registration.sessionFile);
    this.readerTargets.add(targetKey(target));

  }

  getSessionTarget(sessionId: string): SessionTargetIdentity | undefined {
    const matches = this.sessionDirectory.list().filter((target) => target.identity.sessionId === sessionId);
    return matches.length === 1 ? { ...matches[0].identity } : undefined;
  }

  syncDesktopModel(target: DesktopPluginTarget, model: DesktopPluginModel | undefined): void {
    // The event may arrive before Mobile opens the session: remember it per exact target.
    const key = targetKey(target);
    if (model === undefined) this.pendingDesktopModels.delete(key);
    else this.pendingDesktopModels.set(key, model);
    const current = this.sessionDirectory.resolve(target);
    if (!current) return;
    this.sessionDirectory.updateDesktopModel(target, model);
    this.publishDesktopSessionUpdated(target);
  }

  syncDesktopThinking(target: DesktopPluginTarget, level: string | undefined, force = false): void {
    const current = this.sessionDirectory.resolve(target);
    if (!current || (!force && current.thinkingLevel === level)) return;
    const key = targetKey(target);
    if (level === undefined) this.pendingDesktopThinking.delete(key);
    else this.pendingDesktopThinking.set(key, level);
    this.sessionDirectory.updateDesktopThinking(target, level);
    this.publishDesktopSessionUpdated(target);
  }

  syncDesktopRuntimeStatus(target: DesktopPluginTarget, runtimeStatus: DesktopPluginRuntimeStatus): void {
    const current = this.sessionDirectory.resolve(target);
    if (!current) return;
    const key = targetKey(target);
    const previous = this.desktopRuntimeStatuses.get(key);
    this.desktopRuntimeStatuses.set(key, runtimeStatus);
    if (previous === runtimeStatus) return;
    if (previous === "running" && runtimeStatus === "idle") {
      const notification = {
        eventId: `${this.notificationHostInstanceId}:${++this.notificationSequence}:agent_settled:${key}`,
        kind: "agent_settled" as const,
        sessionId: target.sessionId,
        target: { ...target },
        title: `Agent 回复已完成 · ${notificationSessionLabel(target.sessionId)}`,
        body: "桌面会话本轮执行已完成",
        occurredAt: new Date().toISOString(),
        dedupeKey: `agent_settled:${key}:${this.notificationSequence}`,
        priority: "normal" as const,
      };
      void this.notificationDispatcher.enqueue(notification).catch(() => undefined);
      const frame = this.eventLog.record({ type: "notification_event", ...notification });
      for (const listener of this.listeners) {
        try { listener(frame); } catch { /* ignore */ }
      }
    }
    const now = new Date().toISOString();
    const patch: SessionSummaryPatch = runtimeStatus === "running"
      ? { runtimeStatus, activeSince: current.activeSince ?? now, lastActivityAt: now }
      : { runtimeStatus, activeSince: null, lastActivityAt: now };
    this.publishDesktopSummary(target, patch);
  }

  syncDesktopSessionSummary(target: DesktopPluginTarget, summary: DesktopPluginSessionSummary): void {
    this.publishDesktopSummary(target, summary);
  }

  private async publishDesktopSessionUpdated(target: DesktopPluginTarget, includeTimeline = false): Promise<SessionSnapshot | undefined> {
    try {
      const snapshot = await this.sessionQueryService.snapshot(target);
      if (!snapshot.ok || !snapshot.value || !this.sessionDirectory.resolve(target)) return undefined;
      this.emitToListeners(this.eventLog.record({
        type: "session_updated",
        session: snapshot.value.session,
        target,
      }));
      if (includeTimeline) {
        this.emitToListeners(this.eventLog.record({
          type: "timeline_snapshot",
          sessionId: target.sessionId,
          items: snapshot.value.timeline,
          target,
        }));
      }
      return snapshot.value;
    } catch {
      // A target may disconnect while its projection event is being materialized.
      return undefined;
    }
  }

  private emitDesktopTailItems(target: DesktopPluginTarget, items: TimelineItem[]): void {
    for (const item of items) {
      this.emitToListeners(this.eventLog.record({
        type: "timeline_item",
        sessionId: target.sessionId,
        target,
        item,
      }));
    }
  }

  private startDesktopReplayRefresh(target: DesktopPluginTarget, refresh: { timer: ReturnType<typeof setTimeout>; refreshing: boolean; replayQueued: boolean; pendingItems: TimelineItem[] }): void {
    refresh.refreshing = true;
    void this.publishDesktopSessionUpdated(target, true).then((snapshot) => {
      const key = targetKey(target);
      const latest = this.desktopReplayRefreshes.get(key);
      if (!latest || latest !== refresh) return;
      if (latest.replayQueued) {
        latest.replayQueued = false;
        latest.refreshing = false;
        latest.timer = setTimeout(() => this.startDesktopReplayRefresh(target, latest), 100);
        latest.timer.unref?.();
        return;
      }
      if (snapshot) {
        const available = new Map<string, number>();
        for (const item of snapshot.timeline) {
          const itemKey = timelineContentKey(item);
          available.set(itemKey, (available.get(itemKey) ?? 0) + 1);
        }
        latest.pendingItems = latest.pendingItems.filter((item) => {
          const itemKey = timelineContentKey(item);
          const count = available.get(itemKey) ?? 0;
          if (count <= 0) return true;
          available.set(itemKey, count - 1);
          return false;
        });
      }
      this.emitDesktopTailItems(target, latest.pendingItems);
      this.desktopReplayRefreshes.delete(key);
    });
  }

  private scheduleDesktopReplayRefresh(target: DesktopPluginTarget): void {
    const key = targetKey(target);
    const current = this.desktopReplayRefreshes.get(key);
    if (current) {
      if (current.refreshing) current.replayQueued = true;
      return;
    }
    const refresh = {
      timer: setTimeout(() => this.startDesktopReplayRefresh(target, refresh), 100),
      refreshing: false,
      replayQueued: false,
      pendingItems: [] as TimelineItem[],
    };
    refresh.timer.unref?.();
    this.desktopReplayRefreshes.set(key, refresh);
  }

  private publishDesktopTailItems(target: DesktopPluginTarget, items: TimelineItem[]): void {
    const refresh = this.desktopReplayRefreshes.get(targetKey(target));
    if (!refresh) {
      this.emitDesktopTailItems(target, items);
      return;
    }
    refresh.pendingItems.push(...items);
  }

  private ensureDesktopTailWatcher(target: DesktopPluginTarget, sessionFile?: string): void {
    const key = targetKey(target);
    const current = this.desktopTailWatchers.get(key);
    if (!sessionFile) {
      if (current) this.disposeDesktopTailWatcher(target);
      return;
    }
    if (current?.sessionFile === sessionFile && !current.watcher.disposed) return;
    if (current) this.disposeDesktopTailWatcher(target);

    const watcher = new JsonlTailWatcher(sessionFile, (items, appendedEntries, replayed, replaySettled) => {
      if (this.disposed || !this.sessionDirectory.resolve(target)) return;
      if (replayed) {
        if (replaySettled) this.scheduleDesktopReplayRefresh(target);
        return;
      }
      if (appendedEntries === 0) return;
      this.publishDesktopTailItems(target, items);
    });
    this.desktopTailWatchers.set(key, { sessionFile, watcher });
    void watcher.start().catch(() => {
      if (this.desktopTailWatchers.get(key)?.watcher === watcher) this.desktopTailWatchers.delete(key);
    });
  }

  private cancelDesktopReplayRefresh(target: DesktopPluginTarget): void {
    const refresh = this.desktopReplayRefreshes.get(targetKey(target));
    if (!refresh) return;
    clearTimeout(refresh.timer);
    this.desktopReplayRefreshes.delete(targetKey(target));
  }

  private disposeDesktopTailWatcher(target: DesktopPluginTarget): void {
    this.cancelDesktopReplayRefresh(target);
    const key = targetKey(target);
    const entry = this.desktopTailWatchers.get(key);
    if (!entry) return;
    this.desktopTailWatchers.delete(key);
    const disposal = entry.watcher.dispose();
    this.detachedReaderDisposals.add(disposal);
    void disposal.finally(() => this.detachedReaderDisposals.delete(disposal));
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

  onDesktopAskCancelled(target: DesktopPluginTarget, response: DesktopAskResponse): void {
    if (response.response.cancelled !== true) return;
    const pendingEntry = [...this.pendingDesktopAsks.entries()].find(([_, candidate]) =>
      targetKey(candidate.target) === targetKey(target) && candidate.request.requestId === response.requestId && candidate.request.toolCallId === response.toolCallId,
    );
    if (!pendingEntry) return;
    const [id] = pendingEntry;
    this.clearDesktopAsk(id);
  }

  onDesktopPlanRequest(target: DesktopPluginTarget, request: DesktopPlanRequest): void {
    if (this.disposed || request.deadlineAt <= Date.now() || !this.sessionDirectory.resolve(target, "plan")) return;
    const id = planKey(target, request.requestId, request.kind);
    if (this.pendingDesktopPlans.has(id)) return;
    const timer = setTimeout(() => this.clearDesktopPlan(id), request.deadlineAt - Date.now());
    timer.unref?.();
    const event = this.eventLog.record({
      type: "desktop_plan_request",
      sessionId: target.sessionId,
      target: { ...target },
      request,
    });
    this.pendingDesktopPlans.set(id, { target: { ...target }, request, timer });
    this.emitToListeners(event);
  }

  onDesktopPlanCancelled(target: DesktopPluginTarget, cancel: { requestId: string; kind: "confirm" | "review" }): void {
    const id = planKey(target, cancel.requestId, cancel.kind);
    this.clearDesktopPlan(id);
  }

  currentDesktopExecutionEvents(): HostEvent[] {
    return this.desktopPluginRegistry.list().flatMap((registration) => {
      const snapshot = registration.executionSummary;
      if (!snapshot) return [];
      const revision = this.desktopExecutionEventRevisions.get(targetKey(registration.target));
      if (revision === undefined) return [];
      return [this.eventLog.record({
        type: "session_execution_updated",
        summary: {
          ...structuredClone(snapshot),
          target: { ...registration.target },
          revision,
        },
      })];
    });
  }

  pendingDesktopAskEvents(): HostEvent[] {
    return [...this.pendingDesktopAsks.values()]
      .filter(({ request }) => request.deadlineAt > Date.now())
      .map(({ event, request }) => ({ ...event, request: { ...event.request, timeout: Math.max(1, request.deadlineAt - Date.now()) } }));
  }
  pendingDesktopPlanEvents(): HostEvent[] {
    return [...this.pendingDesktopPlans.values()]
      .filter(({ request }) => request.deadlineAt > Date.now())
      .map(({ request, target }) => this.eventLog.record({ type: "desktop_plan_request", sessionId: target.sessionId, target: { ...target }, request }));
  }

  async respondToDesktopPlan(sessionId: string, requestId: string, response: DesktopPlanResponse, target?: SessionTargetIdentity): Promise<boolean> {
    if (!target || target.sessionId !== sessionId) return false;
    const id = planKey(target, requestId, response.kind);
    const pending = this.pendingDesktopPlans.get(id);
    if (!pending || pending.request.kind !== response.kind || pending.request.deadlineAt <= Date.now()) return false;
    const registration = this.desktopPluginRegistry.resolve(target);
    if (!registration?.transport.answerPlan) return false;
    const result = await registration.transport.answerPlan({ ...response, requestId } as DesktopPlanResponse);
    if (result.status !== "accepted") return false;
    this.clearDesktopPlan(id);
    return true;
  }

  private clearDesktopPlan(id: string): void {
    const pending = this.pendingDesktopPlans.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDesktopPlans.delete(id);
    if (!this.disposed) this.emitToListeners(this.eventLog.record({ type: "desktop_plan_cleared", sessionId: pending.target.sessionId, requestId: pending.request.requestId, kind: pending.request.kind, target: { ...pending.target } }));
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

  private publishDesktopExecutionSummary(target: DesktopPluginTarget, snapshot: DesktopPluginExecutionSummary, reset = false): void {
    const key = targetKey(target);
    const revision = ++this.desktopExecutionRevision;
    this.desktopExecutionEventRevisions.set(key, revision);
    const summary: SessionExecutionSummary = {
      ...structuredClone(snapshot),
      target: { ...target },
      revision,
    };
    this.emitToListeners(this.eventLog.record({
      type: "session_execution_updated",
      summary,
      ...(reset ? { reset: true } : {}),
    }));
  }

  private syncDesktopExecutionSummary(target: DesktopPluginTarget, snapshot: DesktopPluginExecutionSummary): void {
    const key = targetKey(target);
    const previousRevision = this.desktopExecutionSourceRevisions.get(key);
    if (previousRevision !== undefined && snapshot.revision <= previousRevision) return;
    this.desktopExecutionSourceRevisions.set(key, snapshot.revision);
    this.publishDesktopExecutionSummary(target, snapshot);
  }

  private clearDesktopExecutionSummary(target: DesktopPluginTarget): void {
    const key = targetKey(target);
    if (!this.desktopExecutionSourceRevisions.has(key)) return;
    this.desktopExecutionSourceRevisions.delete(key);
    this.publishDesktopExecutionSummary(target, {
      revision: 0,
      todos: [],
      teammate: { running: 0, total: 0, agents: [] },
      backgroundJobs: [],
    }, true);
    this.desktopExecutionEventRevisions.delete(key);
  }

  unregisterDesktopTarget(target: DesktopPluginTarget): void {
    // A reconnect may replace the registration before the old socket closes.
    if (this.desktopPluginRegistry.resolve(target)) return;
    this.desktopRuntimeStatuses.delete(targetKey(target));
    this.disposeDesktopTailWatcher(target);
    this.clearDesktopExecutionSummary(target);
    const entry = this.sessionDirectory.resolve(target);
    if (!entry) return;
    for (const [id, pending] of this.pendingDesktopPlans) {
      if (targetKey(pending.target) === targetKey(target)) this.clearDesktopPlan(id);
    }
    for (const [id, pending] of this.pendingDesktopAsks) {
      if (targetKey(pending.target) === targetKey(target)) this.clearDesktopAsk(id);
    }
    this.publishDesktopSummary(target, { reset: true, runtimeStatus: "sleeping", activeSince: null, lastActivityAt: new Date().toISOString() });
    this.sessionDirectory.unregister(target);
    this.readerTargets.delete(targetKey(target));
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
      for (const event of executionProjectionEvents(snapshot.projections)) {
        this.emitToListeners(this.eventLog.record(event));
      }
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
      sessions: this.readerTargets.size,

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

  /** 列出已存在的持久化会话；不会创建或附着 AgentSession。 */
  async listSessions(cwd?: string): Promise<unknown[]> {
    return this.sessionCatalog.listSessions(cwd);
  }

  private async runSessionOperation(operation: SessionOperation): Promise<unknown> {
    const entry = this.sessionDirectory.resolve(operation.target);
    if (!entry) throw new Error("target_unavailable");
    if (operation.kind === "load_more_history") {
      const result = await this.sessionQueryService.history(operation.target, operation.count);
      return result.value ?? { items: [], hasMore: false, totalEntries: 0, historyAvailable: false };
    }
    if (operation.kind === "search_history") {
      if (!entry.sessionFile) return { matches: [], totalEntries: 0, historyAvailable: false };
      return searchInJsonl(entry.sessionFile, operation.keyword, operation.maxResults);
    }
    if (entry.kind !== "desktop") throw new Error("target_unavailable");
    if (operation.kind === "list_models" || operation.kind === "list_skills") {
      return this.desktopControlGateway.query(operation.target, operation.kind);
    }
    throw new Error("unsupported_command");
  }

  /** 处理 extension_ui_response；只允许 exact Desktop target。 */
  async respondToExtensionUi(sessionId: string, requestId: string, response: ExtensionUiResponse, target?: SessionTargetIdentity): Promise<boolean> {
    if (!target || target.sessionId !== sessionId) return false;
    const entry = this.sessionDirectory.resolve(target, "ask");
    if (entry?.kind !== "desktop") return false;
    const pending = this.pendingDesktopAsks.get(requestId);
    if (!pending || targetKey(pending.target) !== targetKey(target) || pending.request.deadlineAt <= Date.now()) return false;
    const result = await this.desktopControlGateway.answerAsk(target, pending.request.requestId, pending.request.toolCallId, response);
    if (result.status !== "accepted") return false;
    this.clearDesktopAsk(requestId);
    return true;
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

  async readNotificationConfig() {
    return this.notificationConfig.redacted();
  }

  async updateNotificationConfig(patch: Record<string, unknown>) {
    await this.notificationConfig.patch(patch);
    return this.notificationConfig.redacted();
  }

  async testNotification(providerId?: string): Promise<{ ok: boolean; results: { providerId: string; ok: boolean; code: string }[] }> {
    const config = await this.notificationConfig.read();
    const selected = providerId ? config.providers.filter((provider) => provider.id === providerId) : config.providers;
    const results: { providerId: string; ok: boolean; code: string }[] = [];
    for (const providerConfig of selected) {
      const provider = notificationProviders.get(providerConfig.kind);
      if (!provider) {
        results.push({ providerId: providerConfig.id, ok: false, code: "unsupported_provider" });
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const result = await provider.test(providerConfig, controller.signal);
        results.push({ providerId: providerConfig.id, ok: result.ok, code: result.code });
      } catch {
        results.push({ providerId: providerConfig.id, ok: false, code: "provider_error" });
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: results.length > 0 && results.every((result) => result.ok), results };
  }

  /** 释放所有资源（关闭时调用） */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopMaestroPoll();
    for (const pending of this.pendingDesktopAsks.values()) clearTimeout(pending.timer);
    this.pendingDesktopAsks.clear();
    for (const refresh of this.desktopReplayRefreshes.values()) clearTimeout(refresh.timer);
    this.desktopReplayRefreshes.clear();
    for (const target of this.desktopTailWatchers.keys()) {
      const [sessionId, endpointId, normalizedCwd, processGeneration] = target.split("\u0000");
      this.disposeDesktopTailWatcher({ sessionId, endpointId, normalizedCwd, processGeneration });
    }
    await Promise.allSettled([...this.detachedReaderDisposals]);
    for (const target of this.sessionDirectory.list()) this.sessionDirectory.unregister(target.identity);
    this.readerTargets.clear();
    this.projectedDesktopTargets.clear();
    await this.notificationDispatcher.stop();
    this.listeners.clear();
  }
}
