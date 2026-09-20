import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import net, { type Server, type Socket } from "node:net";
import type {
  DesktopBrokerDeltaMutation,
  DesktopBrokerAskResult,
  DesktopBrokerError,
  DesktopBrokerHello,
  DesktopBrokerReady,
  DesktopBrokerSnapshotBegin,
  DesktopBrokerSnapshotChunk,
  DesktopBrokerSnapshotEnd,
  DesktopBrokerTargetRecord,
  DesktopBrokerToHostFrame,
  DesktopHostToBrokerFrame,
  DesktopPluginRequest,
  DesktopPluginResult,
  DesktopAskResult,
  DesktopPluginTarget,
  DesktopPluginCapability,
} from "@maestro-mobile/shared";
import {
  DESKTOP_BROKER_PROTOCOL_VERSION,
  isCompatibleReleaseVersion,
  isDesktopBrokerToHostFrame,
  MOBILE_RELEASE_VERSION,
} from "@maestro-mobile/shared";
import { DesktopPluginRegistry, type DesktopPluginRegistration, type DesktopPluginTransport } from "./desktop-plugin-registry.js";
import { JsonLineConnection, removeStaleSocket } from "./desktop-plugin-ipc.js";

export const DEFAULT_DESKTOP_BROKER_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_DESKTOP_BROKER_HANDSHAKE_TIMEOUT_MS = 5_000;

function askCorrelationKey(target: DesktopPluginTarget, requestId: string, toolCallId: string): string {
  return JSON.stringify([target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration, requestId, toolCallId]);
}

function targetKey(target: DesktopPluginTarget): string {
  return [target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration].join("\u0000");
}

function sameTarget(left: DesktopPluginTarget, right: DesktopPluginTarget): boolean {
  return targetKey(left) === targetKey(right);
}

function isSameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export interface DesktopBrokerProjectionListener {
  (records: readonly DesktopBrokerTargetRecord[], brokerInstanceId: string, revision: number): void;
}

class DesktopBrokerTargetTransport implements DesktopPluginTransport {
  private closed = false;

  constructor(
    private readonly link: DesktopBrokerHostLink,
    private readonly target: DesktopPluginTarget,
  ) {}

  request(request: DesktopPluginRequest): Promise<DesktopPluginResult> {
    if (this.closed) return Promise.reject(new Error("desktop broker target disconnected"));
    return this.link.request(request);
  }

  answerAsk(response: Parameters<NonNullable<DesktopPluginTransport["answerAsk"]>>[0]): Promise<DesktopAskResult> {
    if (this.closed) return Promise.resolve({ type: "desktop_ask_result", requestId: response.requestId, toolCallId: response.toolCallId, status: "unknown", error: { code: "disconnected" } });
    return this.link.answerAsk(this.target, response);
  }

  close(): void {
    this.closed = true;
  }
}

export class DesktopBrokerProjectedRegistry {
  private readonly registrations = new Map<string, DesktopPluginRegistration>();
  private _revision = 0;
  private brokerInstanceId?: string;
  private valid = false;

  get revision(): number {
    return this._revision;
  }

  get epoch(): string | undefined {
    return this.brokerInstanceId;
  }

  get isValid(): boolean {
    return this.valid;
  }

  replaceSnapshot(
    brokerInstanceId: string,
    revision: number,
    records: readonly DesktopBrokerTargetRecord[],
    link: DesktopBrokerHostLink,
  ): void {
    this.clearRegistrations();
    const next = new Map<string, DesktopPluginRegistration>();
    for (const record of records) {
      next.set(targetKey(record.target), this.registrationFor(record, link));
    }
    this.registrations.clear();
    for (const [key, registration] of next) this.registrations.set(key, registration);
    this.brokerInstanceId = brokerInstanceId;
    this._revision = revision;
    this.valid = true;
  }

  applyDelta(
    brokerInstanceId: string,
    baseRevision: number,
    revision: number,
    mutation: DesktopBrokerDeltaMutation,
    link: DesktopBrokerHostLink,
  ): boolean {
    if (!this.valid || this.brokerInstanceId !== brokerInstanceId || this._revision !== baseRevision || revision !== baseRevision + 1) {
      this.invalidate();
      return false;
    }
    if (mutation.kind === "upsert") {
      const key = targetKey(mutation.record.target);
      this.registrations.get(key)?.transport.close();
      this.registrations.set(key, this.registrationFor(mutation.record, link));
    } else if (mutation.kind === "remove") {
      const key = targetKey(mutation.target);
      const registration = this.registrations.get(key);
      if (registration) registration.transport.close();
      this.registrations.delete(key);
    } else {
      const registration = this.registrations.get(targetKey(mutation.target));
      if (!registration) {
        this.invalidate();
        return false;
      }
      if (mutation.kind === "model") {
        if (mutation.model === null) delete registration.model;
        else registration.model = structuredClone(mutation.model);
      } else if (mutation.kind === "thinking_level") {
        if (mutation.level === null) delete registration.thinkingLevel;
        else registration.thinkingLevel = mutation.level;
      } else if (mutation.kind === "runtime_status") {
        registration.runtimeStatus = mutation.runtimeStatus;
      } else {
        registration.summary = structuredClone(mutation.summary);
        registration.runtimeStatus = mutation.summary.runtimeStatus;
      }
    }
    this._revision = revision;
    return true;
  }

  register(registration: Omit<DesktopPluginRegistration, "runtimeStatus"> & { runtimeStatus?: DesktopPluginRegistration["runtimeStatus"] }): DesktopPluginTarget {
    const key = targetKey(registration.target);
    this.registrations.get(key)?.transport.close();
    this.registrations.set(key, {
      ...registration,
      target: { ...registration.target },
      ...(registration.sessionFile ? { sessionFile: registration.sessionFile } : {}),
      capabilities: [...registration.capabilities],
      runtimeStatus: registration.runtimeStatus ?? "idle",
    });
    this.brokerInstanceId ??= "manual";
    this._revision += 1;
    this.valid = true;
    return { ...registration.target };
  }

  unregister(target: DesktopPluginTarget, expectedTransport?: DesktopPluginTransport): boolean {
    const key = targetKey(target);
    const registration = this.registrations.get(key);
    if (!registration || (expectedTransport && registration.transport !== expectedTransport)) return false;
    this.registrations.delete(key);
    registration.transport.close();
    this._revision += 1;
    return true;
  }

  invalidate(): void {
    this.clearRegistrations();
    this.valid = false;
  }

  clear(): void {
    this.invalidate();
  }


  resolve(target: DesktopPluginTarget): DesktopPluginRegistration | undefined {
    return this.registrations.get(targetKey(target));
  }

  hasCapability(target: DesktopPluginTarget, capability: DesktopPluginCapability): boolean {
    return this.resolve(target)?.capabilities.includes(capability) ?? false;
  }

  list(): DesktopPluginRegistration[] {
    return [...this.registrations.values()].map((registration) => ({
      ...registration,
      target: { ...registration.target },
      ...(registration.sessionFile ? { sessionFile: registration.sessionFile } : {}),
      capabilities: [...registration.capabilities],
      ...(registration.model ? { model: structuredClone(registration.model) } : {}),
      ...(registration.thinkingLevel ? { thinkingLevel: registration.thinkingLevel } : {}),
      ...(registration.summary ? { summary: structuredClone(registration.summary) } : {}),
    }));
  }

  private registrationFor(record: DesktopBrokerTargetRecord, link: DesktopBrokerHostLink): DesktopPluginRegistration {
    return {
      target: { ...record.target },
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      capabilities: [...record.capabilities],
      transport: new DesktopBrokerTargetTransport(link, record.target),
      ...(record.model ? { model: structuredClone(record.model) } : {}),
      ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
      runtimeStatus: record.runtimeStatus,
      ...(record.summary ? { summary: structuredClone(record.summary) } : {}),
      ...(record.connectedAt ? { connectedAt: record.connectedAt } : {}),
      ...(record.lastEventAt ? { lastEventAt: record.lastEventAt } : {}),
    };
  }

  private clearRegistrations(): void {
    for (const registration of this.registrations.values()) registration.transport.close();
    this.registrations.clear();
  }
}

interface PendingRequest {
  target: DesktopPluginTarget;
  resolve: (result: DesktopPluginResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingAskResponse {
  target: DesktopPluginTarget;
  requestId: string;
  toolCallId: string;
  resolve: (result: DesktopAskResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DesktopBrokerHostLink {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingAskResponses = new Map<string, PendingAskResponse>();
  private closed = false;

  constructor(
    private readonly connection: JsonLineConnection,
    private readonly now: () => number = Date.now,
  ) {}

  request(request: DesktopPluginRequest): Promise<DesktopPluginResult> {
    if (this.closed) return Promise.reject(new Error("desktop broker disconnected"));
    const remaining = request.deadlineAt - this.now();
    if (remaining <= 0) return Promise.reject(new Error("desktop broker deadline exceeded"));
    return new Promise<DesktopPluginResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error("desktop broker deadline exceeded"));
      }, remaining);
      this.pending.set(request.requestId, { target: request.target, resolve, reject, timer });
      try {
        this.connection.send({ type: "desktop_broker_command", request });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error("desktop broker disconnected"));
      }
    });
  }

  answerAsk(target: DesktopPluginTarget, response: Parameters<NonNullable<DesktopPluginTransport["answerAsk"]>>[0]): Promise<DesktopAskResult> {
    if (this.closed) return Promise.resolve({ type: "desktop_ask_result", requestId: response.requestId, toolCallId: response.toolCallId, status: "unknown", error: { code: "disconnected" } });
    const key = askCorrelationKey(target, response.requestId, response.toolCallId);
    return new Promise<DesktopAskResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAskResponses.delete(key);
        resolve({ type: "desktop_ask_result", requestId: response.requestId, toolCallId: response.toolCallId, status: "unknown", error: { code: "deadline_exceeded" } });
      }, 2_000);
      this.pendingAskResponses.set(key, { target: { ...target }, requestId: response.requestId, toolCallId: response.toolCallId, resolve, reject, timer });
      try {
        this.connection.send({ type: "desktop_broker_ask_response", target, response });
      } catch (error) {
        clearTimeout(timer);
        this.pendingAskResponses.delete(key);
        resolve({ type: "desktop_ask_result", requestId: response.requestId, toolCallId: response.toolCallId, status: "unknown", error: { code: "disconnected" } });
      }
    });
  }

  handleAskResult(frame: DesktopBrokerAskResult): void {
    const key = askCorrelationKey(frame.target, frame.result.requestId, frame.result.toolCallId);
    const pending = this.pendingAskResponses.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAskResponses.delete(key);
    pending.resolve(frame.result);
  }

  handle(frame: Extract<DesktopBrokerToHostFrame, { type: "desktop_broker_command_result" }>): void {
    const pending = this.pending.get(frame.result.requestId);
    if (!pending || !sameTarget(pending.target, frame.target)) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.result.requestId);
    pending.resolve(frame.result);
  }

  close(error = new Error("desktop broker disconnected")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pendingAskResponses.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ type: "desktop_ask_result", requestId: pending.requestId, toolCallId: pending.toolCallId, status: "unknown", error: { code: "disconnected" } });
    }
    this.pendingAskResponses.clear();
    this.connection.close(error);
  }
}

export interface DesktopBrokerHostIpcOptions {
  socketPath: string;
  secret: string;
  hostInstanceId?: string;
  maxFrameBytes?: number;
  handshakeTimeoutMs?: number;
  releaseVersion?: string;
  projection?: DesktopBrokerProjectedRegistry;
  onProjection?: DesktopBrokerProjectionListener;
  onAskRequest?: (target: DesktopPluginTarget, request: Extract<DesktopBrokerToHostFrame, { type: "desktop_broker_ask_request" }>["request"]) => void;
  onDisconnected?: () => void;
}

export class DesktopBrokerHostIpc {
  readonly projection: DesktopBrokerProjectedRegistry;
  private readonly server: Server;
  private readonly hostInstanceId: string;
  private link: DesktopBrokerHostLink | undefined;
  private started = false;
  private closed = false;
  private brokerInstanceId: string | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private connection: JsonLineConnection | undefined;
  private staging: {
    brokerInstanceId: string;
    snapshotId: string;
    revision: number;
    targetCount: number;
    nextChunkIndex: number;
    records: DesktopBrokerTargetRecord[];
  } | undefined;
  private readonly linkTransitions: number[] = [];
  private flappingUntil = 0;

  constructor(private readonly options: DesktopBrokerHostIpcOptions) {
    if (!options.socketPath) throw new Error("desktop broker host socket path is required");
    if (!options.secret) throw new Error("desktop broker host secret is required");
    this.hostInstanceId = options.hostInstanceId ?? randomBytes(12).toString("hex");
    this.projection = options.projection ?? new DesktopBrokerProjectedRegistry();
    this.server = net.createServer((socket) => this.accept(socket));
  }

  get isConnected(): boolean {
    return this.link !== undefined;
  }
  get isFlapping(): boolean {
    return Date.now() < this.flappingUntil;
  }

  private recordLinkTransition(): void {
    const now = Date.now();
    this.linkTransitions.push(now);
    while (this.linkTransitions[0] !== undefined && this.linkTransitions[0] < now - 10_000) this.linkTransitions.shift();
    if (this.linkTransitions.length >= 4) this.flappingUntil = now + 5_000;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.closed = false;
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.options.socketPath), 0o700).catch(() => undefined);
    await removeStaleSocket(this.options.socketPath);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.socketPath);
    });
    await chmod(this.options.socketPath, 0o600).catch(() => undefined);
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    const link = this.link;
    this.link = undefined;
    const connection = this.connection;
    this.connection = undefined;
    this.staging = undefined;
    link?.close();
    connection?.close();
    this.projection.invalidate();
    if (!this.started) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await unlink(this.options.socketPath).catch(() => undefined);
    this.started = false;
  }

  private accept(socket: Socket): void {
    if (this.connection) {
      socket.destroy();
      return;
    }
    const connection = new JsonLineConnection(
      socket,
      this.options.maxFrameBytes ?? DEFAULT_DESKTOP_BROKER_MAX_FRAME_BYTES,
      (raw) => this.handleRaw(connection, raw),
      (error) => this.handleClosed(connection, error),
    );
    this.connection = connection;
    this.handshakeTimer = setTimeout(() => {
      this.sendError(connection, "authentication_failed");
      connection.close(new Error("desktop broker handshake timeout"));
    }, this.options.handshakeTimeoutMs ?? DEFAULT_DESKTOP_BROKER_HANDSHAKE_TIMEOUT_MS);
  }

  private handleRaw(connection: JsonLineConnection, raw: unknown): void {
    if (!this.link) {
      if (!isDesktopBrokerToHostFrame(raw) || raw.type !== "desktop_broker_hello") {
        this.sendError(connection, "invalid_frame");
        connection.close(new Error("desktop broker hello required"));
        return;
      }
      const hello = raw as DesktopBrokerHello;
      if (!isSameSecret(hello.secret, this.options.secret)) {
        this.sendError(connection, "authentication_failed");
        connection.close(new Error("desktop broker authentication failed"));
        return;
      }
      const expectedRelease = this.options.releaseVersion ?? MOBILE_RELEASE_VERSION;
      if (hello.releaseVersion !== undefined && !isCompatibleReleaseVersion(hello.releaseVersion, expectedRelease)) {
        this.sendError(connection, "release_version_unsupported");
        connection.close(new Error("desktop broker release unsupported"));
        return;
      }
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.brokerInstanceId = hello.brokerInstanceId;
      this.recordLinkTransition();
      this.link = new DesktopBrokerHostLink(connection);
      this.projection.invalidate();
      const ready: DesktopBrokerReady = {
        type: "desktop_broker_ready",
        protocolVersion: DESKTOP_BROKER_PROTOCOL_VERSION,
        hostInstanceId: this.hostInstanceId,
        ...(expectedRelease ? { releaseVersion: expectedRelease } : {}),
      };
      connection.send(ready);
      return;
    }
    if (!isDesktopBrokerToHostFrame(raw)) {
      this.sendError(connection, "invalid_frame");
      return;
    }
    this.handleFrame(raw);
  }

  private handleFrame(frame: DesktopBrokerToHostFrame): void {
    if (frame.type === "desktop_broker_snapshot_begin") return this.handleSnapshotBegin(frame);
    if (frame.type === "desktop_broker_snapshot_chunk") return this.handleSnapshotChunk(frame);
    if (frame.type === "desktop_broker_snapshot_end") return this.handleSnapshotEnd(frame);
    if (frame.type === "desktop_broker_delta") {
      const accepted = this.link && this.projection.applyDelta(frame.brokerInstanceId, frame.baseRevision, frame.revision, frame.mutation, this.link);
      if (!accepted) {
        this.notifyProjection();
        this.sendError(this.connection, "revision_gap");
        this.connection?.closeAfterFlush(new Error("desktop broker revision gap"));
      } else {
        this.notifyProjection();
      }
      return;
    }
    if (frame.type === "desktop_broker_command_result") {
      this.link?.handle(frame);
      return;
    }
    if (frame.type === "desktop_broker_ask_result") {
      this.link?.handleAskResult(frame);
      return;
    }
    if (frame.type === "desktop_broker_ask_request") {
      this.options.onAskRequest?.(frame.target, frame.request);
    }
  }

  private handleSnapshotBegin(frame: DesktopBrokerSnapshotBegin): void {
    if (this.staging) {
      this.failSnapshot();
      return;
    }
    if (this.projection.epoch && this.projection.epoch !== frame.brokerInstanceId) {
      this.projection.invalidate();
      this.notifyProjection();
    }
    this.staging = {
      brokerInstanceId: frame.brokerInstanceId,
      snapshotId: frame.snapshotId,
      revision: frame.revision,
      targetCount: frame.targetCount,
      nextChunkIndex: 0,
      records: [],
    };
  }

  private handleSnapshotChunk(frame: DesktopBrokerSnapshotChunk): void {
    const staging = this.staging;
    if (!staging || frame.brokerInstanceId !== staging.brokerInstanceId || frame.snapshotId !== staging.snapshotId
      || frame.revision !== staging.revision || frame.chunkIndex !== staging.nextChunkIndex
      || staging.records.length + frame.records.length > staging.targetCount) {
      this.failSnapshot();
      return;
    }
    staging.records.push(...frame.records);
    staging.nextChunkIndex += 1;
  }

  private handleSnapshotEnd(frame: DesktopBrokerSnapshotEnd): void {
    const staging = this.staging;
    if (!staging || frame.brokerInstanceId !== staging.brokerInstanceId || frame.snapshotId !== staging.snapshotId
      || frame.revision !== staging.revision || frame.chunkCount !== staging.nextChunkIndex
      || staging.records.length !== staging.targetCount || !this.link) {
      this.failSnapshot();
      return;
    }
    const keys = new Set(staging.records.map((record) => targetKey(record.target)));
    if (keys.size !== staging.records.length) {
      this.failSnapshot();
      return;
    }
    const link = this.link;
    this.staging = undefined;
    this.projection.replaceSnapshot(staging.brokerInstanceId, staging.revision, staging.records, link);
    this.notifyProjection();
  }

  private failSnapshot(): void {
    this.staging = undefined;
    this.projection.invalidate();
    this.notifyProjection();
    this.sendError(this.connection, "revision_gap");
    this.connection?.closeAfterFlush(new Error("desktop broker snapshot invalid"));
  }

  private notifyProjection(): void {
    const brokerInstanceId = this.projection.epoch ?? this.brokerInstanceId;
    if (!brokerInstanceId) return;
    this.options.onProjection?.(this.projection.list().map((registration) => ({
      target: { ...registration.target },
      ...(registration.sessionFile ? { sessionFile: registration.sessionFile } : {}),
      capabilities: [...registration.capabilities],
      ...(registration.model ? { model: structuredClone(registration.model) } : {}),
      ...(registration.thinkingLevel ? { thinkingLevel: registration.thinkingLevel } : {}),
      runtimeStatus: registration.runtimeStatus,
      ...(registration.summary ? { summary: structuredClone(registration.summary) } : {}),
      ...(registration.connectedAt ? { connectedAt: registration.connectedAt } : {}),
      ...(registration.lastEventAt ? { lastEventAt: registration.lastEventAt } : {}),
    })), brokerInstanceId, this.projection.revision);
  }

  private handleClosed(connection: JsonLineConnection, error?: Error): void {
    if (this.connection !== connection) return;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (!this.closed) this.recordLinkTransition();
    const link = this.link;
    this.link = undefined;
    this.connection = undefined;
    this.staging = undefined;
    link?.close(error ?? new Error("desktop broker disconnected"));
    this.projection.invalidate();
    this.options.onProjection?.([], this.brokerInstanceId ?? "unknown", this.projection.revision);
    this.options.onDisconnected?.();
    void error;
  }

  private sendError(connection: JsonLineConnection | undefined, code: DesktopBrokerError["code"]): void {
    if (!connection) return;
    try {
      connection.send({ type: "desktop_broker_error", code, message: code });
    } catch {
      // The connection is already closed.
    }
  }
}
