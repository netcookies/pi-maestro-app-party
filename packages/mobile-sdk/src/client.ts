/**
 * Platform-agnostic Mobile Host protocol client.
 *
 * This module deliberately owns transport/session mechanics only. React Native
 * state, persistence, notifications and background lifecycle remain in the app.
 */
import type {
  ClientCommand,
  CommandResult,
  ExecutionProjection,
  ExtensionUiResponse,
  HostEvent,
  ProtocolCapability,
  SessionSnapshot,
  SessionTargetIdentity,
} from "./protocol/index.js";
import type { DesktopPlanResponse } from "./mobile-plan-protocol.js";
import {
  isCompatibleProtocolVersion,
  isHostFrame,
  isHostEvent,
  MOBILE_PRODUCT_VERSION,
  MOBILE_PROTOCOL_MAJOR,
  MOBILE_PROTOCOL_REVISION,
  MOBILE_SDK_VERSION,
} from "./protocol/index.js";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface MobileClientOptions {
  url: string;
  token?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  wsFactory?: (url: string, token?: string) => WebSocketLike;
  random?: () => number;
  /** Product version for diagnostics and legacy bridge only. */
  clientVersion?: string;
  /** SDK package version for diagnostics only. */
  sdkVersion?: string;
  /** Legacy product release field retained during bridge migration. */
  releaseVersion?: string;
  capabilities?: ProtocolCapability[];
  onEvent?: (event: HostEvent) => void;
  onStateChange?: (state: ConnectionState) => void;
  onRevisionChange?: (revision: number) => void;
  onConnectionError?: (message: string) => void;
}

/** Backward-compatible name used by the pre-SDK app wrapper. */
export type HostClientOptions = MobileClientOptions;

export const WS_OPEN = 1;

export function calculateBackoffDelay(
  baseMs: number,
  maxMs: number,
  attempt: number,
  random: () => number = Math.random,
): number {
  const backoff = Math.min(baseMs * 2 ** attempt, maxMs);
  return backoff * (0.5 + random() * 0.5);
}

export class CommandConnectionLostError extends Error {
  readonly code = "connection_lost";

  constructor(commandType: string) {
    super(`Connection lost before response (${commandType})`);
    this.name = "CommandConnectionLostError";
  }
}

export class ProtocolNotReadyError extends Error {
  readonly code = "protocol_not_ready";

  constructor() {
    super("Protocol v2 handshake is not ready");
    this.name = "ProtocolNotReadyError";
  }
}

export class CommandCancelledError extends Error {
  readonly code = "command_cancelled";
  constructor() { super("Command waiter cancelled locally"); this.name = "CommandCancelledError"; }
}

export class CommandFailedError extends Error {
  readonly code: string;
  readonly status: CommandResult["status"];
  readonly details: NonNullable<CommandResult["error"]>["details"];
  readonly revision: number;
  readonly requestId: string;

  constructor(result: CommandResult) {
    super(result.error?.message ?? result.error?.code ?? "Command failed");
    this.name = "CommandFailedError";
    this.code = result.error?.code ?? "command_failed";
    this.status = result.status;
    this.details = result.error?.details;
    this.revision = result.revision;
    this.requestId = result.in_reply_to;
  }
}

export class MobileClient {
  private ws: WebSocketLike | null = null;
  private state: ConnectionState = "disconnected";
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly random: () => number;
  private reconnectAttempt = 0;
  private socketGeneration = 0;
  private connectedAt = 0;
  private connectStartedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private authFailed = false;
  private suspectAuthFailure = false;
  private pendingCommands = new Map<string, {
    resolve(result: unknown): void;
    reject(error: Error): void;
    commandType: string;
  }>();
  private commandSeq = 0;
  private heartbeatPingTimer: ReturnType<typeof setInterval> | null = null;
  private protocolReady = false;
  private helloSeq = 0;
  private eventListeners = new Set<(event: HostEvent) => void>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private errorListeners = new Set<(message: string) => void>();
  private revisionListeners = new Set<(revision: number) => void>();

  private readonly productVersion: string;
  private readonly sdkVersion: string;

  constructor(private readonly options: MobileClientOptions) {
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15000;
    this.random = options.random ?? Math.random;
    this.productVersion = options.clientVersion ?? MOBILE_PRODUCT_VERSION;
    this.sdkVersion = options.sdkVersion ?? MOBILE_SDK_VERSION;
  }

  get isProtocolReady(): boolean { return this.protocolReady; }
  get connectionState(): ConnectionState { return this.state; }
  get isConnected(): boolean { return this.state === "connected"; }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onConnectionError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onRevision(listener: (revision: number) => void): () => void {
    this.revisionListeners.add(listener);
    return () => this.revisionListeners.delete(listener);
  }

  connect(): void {
    if (this.ws || this.reconnectTimer) return;
    this.closed = false;
    this.authFailed = false;
    this.openSocket();
  }

  suspend(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.stopPing();
    this.protocolReady = false;
    this.socketGeneration += 1;
    this.ws?.close();
    this.ws = null;
    this.rejectAllPending("closed");
    this.setState("disconnected");
  }

  reconnectNow(): void {
    this.closed = false;
    this.authFailed = false;
    this.suspectAuthFailure = false;
    this.clearReconnectTimer();
    this.stopPing();
    this.protocolReady = false;
    this.socketGeneration += 1;
    this.ws?.close();
    this.ws = null;
    this.setState("reconnecting");
    this.rejectAllPending("connection_lost");
    this.openSocket();
  }

  close(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.stopPing();
    this.protocolReady = false;
    this.socketGeneration += 1;
    this.ws?.close();
    this.ws = null;
    this.setState("disconnected");
    this.rejectAllPending("closed");
  }

  dispose(): void {
    this.close();
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.eventListeners.clear();
    this.stateListeners.clear();
    this.errorListeners.clear();
    this.revisionListeners.clear();
  }

  sendCommand(command: ClientCommand & { id?: string }, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new CommandCancelledError());
    if (!this.protocolReady || !this.ws || this.ws.readyState !== WS_OPEN) {
      return Promise.reject(new ProtocolNotReadyError());
    }
    const id = command.id ?? `cmd-${++this.commandSeq}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { this.pendingCommands.delete(id); cleanup(); reject(new CommandCancelledError()); };
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        cleanup();
        reject(new Error(`Command timeout: ${payload.type}`));
      }, timeoutMs);
      this.pendingCommands.set(id, {
        commandType: payload.type,
        resolve: (result) => { cleanup(); resolve(result); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.sendRaw(JSON.stringify(payload)); }
      catch (error) { this.pendingCommands.delete(id); cleanup(); reject(error); }
    });
  }

  respondExtensionUi(sessionId: string, requestId: string, response: ExtensionUiResponse, target: SessionTargetIdentity): Promise<unknown> {
    return this.sendCommand({ type: "extension_ui_response", sessionId, requestId, response, target });
  }

  respondDesktopPlan(sessionId: string, requestId: string, response: DesktopPlanResponse, target: SessionTargetIdentity): Promise<unknown> {
    return this.sendCommand({ type: "desktop_plan_response", sessionId, requestId, response, target });
  }

  getExecutionProjections(options?: { signal?: AbortSignal }): Promise<{ projections: ExecutionProjection[]; revision: number }> {
    return this.sendCommand({ type: "get_execution_projections" }, 30_000, options?.signal) as Promise<{ projections: ExecutionProjection[]; revision: number }>;
  }

  getSnapshot(sessionId: string, target: SessionTargetIdentity, options?: { signal?: AbortSignal }): Promise<SessionSnapshot> {
    return this.sendCommand({ type: "get_snapshot", sessionId, target }, 30_000, options?.signal) as Promise<SessionSnapshot>;
  }

  private openSocket(): void {
    this.setState(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const factory = this.options.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    let wsUrl = this.options.url;
    if (this.options.token) {
      try {
        const u = new URL(wsUrl);
        u.searchParams.set("token", this.options.token);
        wsUrl = u.toString();
      } catch {
        wsUrl = `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.options.token)}`;
      }
    }

    let ws: WebSocketLike;
    try {
      ws = factory(wsUrl, this.options.token);
    } catch {
      this.emitError("transport_open_failed");
      this.scheduleReconnect();
      return;
    }
    this.connectStartedAt = Date.now();
    const generation = ++this.socketGeneration;
    this.ws = ws;

    ws.onopen = () => {
      if (generation !== this.socketGeneration || this.closed) return;
      this.protocolReady = false;
      this.sendHello();
    };
    ws.onmessage = (data) => {
      if (generation !== this.socketGeneration) return;
      this.handleRawMessage(data.data, generation);
    };
    ws.onclose = () => {
      if (generation !== this.socketGeneration) return;
      this.socketGeneration += 1;
      this.ws = null;
      this.stopPing();
      this.protocolReady = false;
      if (this.closed) return;
      this.rejectAllPending("connection_lost");
      if (this.state !== "connected" && this.reconnectAttempt >= 1) {
        this.suspectAuthFailure = true;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose performs the single lifecycle transition.
    };
  }

  private stopPing(): void {
    if (this.heartbeatPingTimer) clearInterval(this.heartbeatPingTimer);
    this.heartbeatPingTimer = null;
  }

  private startPing(): void {
    this.stopPing();
    this.heartbeatPingTimer = setInterval(() => {
      if (this.state === "connected" && !this.closed) this.sendCommand({ type: "ping" }).catch(() => {});
    }, 20_000);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.suspectAuthFailure) {
      this.suspectAuthFailure = false;
      this.setState("reconnecting");
      void this.verifyAuthFailure();
      return;
    }
    this.setState("reconnecting");
    const delay = calculateBackoffDelay(this.reconnectBaseMs, this.reconnectMaxMs, this.reconnectAttempt, this.random);
    this.reconnectAttempt++;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async verifyAuthFailure(): Promise<void> {
    try {
      const httpBase = this.options.url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/ws$/, "").replace(/\/$/, "");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      let res: Response;
      try {
        res = await fetch(`${httpBase}/api/health`, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (this.closed || this.state === "connected") return;
      if (res.status === 401) {
        this.authFailed = true;
        this.clearReconnectTimer();
        this.setState("disconnected");
        this.emitError("token 校验失败 —— 在 PC 终端执行 /maestro-mobile qr 重新扫码配对");
      }
    } catch {
      // Network failure is not evidence of an invalid token; resume normal backoff.
      if (!this.closed && this.state !== "connected") this.scheduleReconnect();
    }
  }

  private sendHello(): void {
    const hello = {
      type: "protocol_hello" as const,
      protocolVersion: MOBILE_PROTOCOL_MAJOR,
      protocolRevision: MOBILE_PROTOCOL_REVISION,
      sdkVersion: this.sdkVersion,
      clientVersion: this.productVersion,
      // Kept during the bridge period for old Hosts; never used by the new SDK to gate ready.
      releaseVersion: this.options.releaseVersion ?? this.productVersion,
      capabilities: this.options.capabilities ?? ["session_control", "extension_ui", "monitor_read", "session_filter", "execution_projection_read", "plan", "notification_control", "background_transport"],
      requestId: `hello-${++this.helloSeq}`,
    };
    this.sendRaw(JSON.stringify(hello));
  }

  private handleRawMessage(raw: unknown, generation?: number): void {
    let message: unknown;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    if (m.type === "protocol_ready") {
      if (!isHostFrame(message) || message.type !== "protocol_ready"
        || !isCompatibleProtocolVersion(message.protocolVersion)
        || (message.protocolRevision !== undefined && message.protocolRevision !== MOBILE_PROTOCOL_REVISION)) {
        this.emitError("invalid or incompatible protocol_ready frame");
        return;
      }
      this.protocolReady = true;
      this.connectedAt = Date.now();
      this.startPing();
      this.setState("connected");
      this.emitRevision(message.revision);
      if (this.resetTimer) clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => {
        if (generation === this.socketGeneration && this.ws && Date.now() - this.connectedAt >= 30_000) this.reconnectAttempt = 0;
      }, 30_000);
      return;
    }
    if (m.type === "protocol_error") {
      if (!isHostFrame(message)) return;
      this.protocolReady = false;
      this.stopPing();
      this.setState("disconnected");
      const code = typeof m.code === "string" ? m.code : "protocol_error";
      const detail = typeof m.message === "string" ? m.message : "Protocol v2 handshake failed";
      this.emitError(`${code}: ${detail}`);
      this.rejectAllPending("not_connected");
      return;
    }
    if (m.type === "command_result") {
      if (!isHostFrame(message)) return;
      if (typeof m.revision === "number" && Number.isFinite(m.revision)) this.emitRevision(m.revision);
      this.resolveCommand(m);
      return;
    }
    if (m.type === "snapshot" && m.snapshot) {
      this.resolveCommand(m, m.snapshot);
      return;
    }
    if (isHostEvent(message)) this.emitEvent(message);
  }

  private resolveCommand(message: Record<string, unknown>, value?: unknown): void {
    const inReplyTo = typeof message.in_reply_to === "string" ? message.in_reply_to : "";
    const pending = this.pendingCommands.get(inReplyTo);
    if (!pending) return;
    this.pendingCommands.delete(inReplyTo);
    if (message.ok === true) pending.resolve(value ?? message.result ?? null);
    else {
      const frame: unknown = message;
      pending.reject(isHostFrame(frame) && frame.type === "command_result"
        ? new CommandFailedError(frame)
        : new Error("Command failed"));
    }
  }

  private rejectAllPending(reason: "connection_lost" | "closed" | "not_connected"): void {
    if (this.pendingCommands.size === 0) return;
    const pending = [...this.pendingCommands.values()];
    this.pendingCommands.clear();
    const errors = pending.map((cmd) => reason === "connection_lost"
      ? new CommandConnectionLostError(cmd.commandType)
      : new Error(reason === "closed" ? "HostClient closed" : "Not connected"));
    for (let i = 0; i < pending.length; i++) pending[i].reject(errors[i]);
    if (reason === "connection_lost") {
      this.emitError(pending.length > 1
        ? `${errors[0].message}（另有 ${pending.length - 1} 条命令状态未知）`
        : errors[0].message);
    }
  }

  private sendRaw(data: string): void {
    if (this.ws && this.ws.readyState === WS_OPEN) this.ws.send(data);
    else this.rejectAllPending("not_connected");
  }

  private emitEvent(event: HostEvent): void {
    this.options.onEvent?.(event);
    for (const listener of this.eventListeners) listener(event);
  }

  private emitError(message: string): void {
    this.options.onConnectionError?.(message);
    for (const listener of this.errorListeners) listener(message);
  }

  private emitRevision(revision: number): void {
    this.options.onRevisionChange?.(revision);
    for (const listener of this.revisionListeners) listener(revision);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
    for (const listener of this.stateListeners) listener(state);
  }
}

/** Factory used by non-React consumers and future adapters. */
export function createMobileClient(options: MobileClientOptions): MobileClient {
  return new MobileClient(options);
}

/** Compatibility alias while the app migrates from HostClient. */
export { MobileClient as HostClient };
