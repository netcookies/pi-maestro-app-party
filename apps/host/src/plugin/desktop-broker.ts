import { randomUUID } from "node:crypto";
import net from "node:net";
import type {
  DesktopAskRequest,
  DesktopAskResult,
  DesktopBrokerAskResult,
  DesktopBrokerToHostFrame,
  DesktopHostToBrokerFrame,
  DesktopPluginCapability,
  DesktopPluginResult,
  DesktopPluginTarget,
} from "@maestro-mobile/shared";
import {
  DESKTOP_BROKER_MAX_SNAPSHOT_RECORDS,
  DESKTOP_BROKER_PROTOCOL_VERSION,
  isDesktopHostToBrokerFrame,
  MOBILE_RELEASE_VERSION,
} from "@maestro-mobile/shared";
import { JsonLineConnection, DesktopPluginIpcServer } from "./desktop-plugin-ipc.js";
import { DesktopPluginRegistry } from "./desktop-plugin-registry.js";

export interface DesktopBrokerOptions {
  pluginSocketPath: string;
  secret: string;
  registryPath?: string;
  brokerInstanceId?: string;
  registry?: DesktopPluginRegistry;
  snapshotChunkSize?: number;
  onFrame?: (frame: DesktopBrokerToHostFrame) => void;
}

export class DesktopBroker {
  readonly brokerInstanceId: string;
  readonly registry: DesktopPluginRegistry;
  readonly pluginServer: DesktopPluginIpcServer;
  private readonly frameListeners = new Set<(frame: DesktopBrokerToHostFrame) => void>();
  private readonly snapshotChunkSize: number;
  private readonly unsubscribeRegistry: () => void;
  private readonly pendingAsks = new Map<string, { target: DesktopPluginTarget; request: DesktopAskRequest; timer: ReturnType<typeof setTimeout> }>();
  private readonly expiredAsks = new Map<string, { target: DesktopPluginTarget; requestId: string; toolCallId: string; timer: ReturnType<typeof setTimeout> }>();

  private askKey(target: DesktopPluginTarget, requestId: string): string {
    return JSON.stringify([target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration, requestId]);
  }

  pendingAskFrames(): DesktopBrokerToHostFrame[] {
    return [...this.pendingAsks.values()]
      .filter(({ request }) => request.deadlineAt > Date.now())
      .map(({ target, request }) => ({ type: "desktop_broker_ask_request", target, request }));
  }

  constructor(private readonly options: DesktopBrokerOptions) {
    this.brokerInstanceId = options.brokerInstanceId ?? randomUUID();
    this.snapshotChunkSize = options.snapshotChunkSize ?? DESKTOP_BROKER_MAX_SNAPSHOT_RECORDS;
    if (!Number.isSafeInteger(this.snapshotChunkSize) || this.snapshotChunkSize < 1 || this.snapshotChunkSize > DESKTOP_BROKER_MAX_SNAPSHOT_RECORDS) {
      throw new Error("invalid desktop broker snapshot chunk size");
    }
    this.registry = options.registry ?? new DesktopPluginRegistry({
      filePath: options.registryPath,
      brokerInstanceId: this.brokerInstanceId,
    });
    if (options.onFrame) this.frameListeners.add(options.onFrame);
    this.unsubscribeRegistry = this.registry.subscribe((change) => {
      if (change.mutation.kind === "remove") {
        for (const [key, pending] of this.pendingAsks) {
          if (this.askKey(pending.target, pending.request.requestId) === key
            && this.askKey(change.mutation.target, pending.request.requestId) === key) this.clearAsk(key);
        }
      }
      this.emit({
        type: "desktop_broker_delta",
        brokerInstanceId: this.brokerInstanceId,
        baseRevision: change.baseRevision,
        revision: change.revision,
        mutation: change.mutation,
      });
    });
    this.pluginServer = new DesktopPluginIpcServer({
      socketPath: options.pluginSocketPath,
      secret: options.secret,
      registry: this.registry,
      supportedEvents: ["model_select", "thinking_level_select", "runtime_status", "session_summary"],
      onAskRequest: (target, request) => {
        if (!this.registry.resolve(target) || request.deadlineAt <= Date.now()) return;
        const key = this.askKey(target, request.requestId);
        this.clearAsk(key);
        if (this.pendingAsks.size >= 64) this.clearAsk(this.pendingAsks.keys().next().value!);
        const timer = setTimeout(() => this.expireAsk(key), request.deadlineAt - Date.now());
        timer.unref?.();
        this.pendingAsks.set(key, { target: { ...target }, request, timer });
        this.emit({ type: "desktop_broker_ask_request", target, request });
      },
    });
  }

  subscribe(listener: (frame: DesktopBrokerToHostFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.pluginServer.start();
  }

  async close(): Promise<void> {
    this.unsubscribeRegistry();
    for (const key of this.pendingAsks.keys()) this.clearAsk(key);
    for (const expired of this.expiredAsks.values()) clearTimeout(expired.timer);
    this.expiredAsks.clear();
    await this.pluginServer.close();
    await this.registry.flush();
    await this.registry.closeStore();
  }

  createSnapshotFrames(): DesktopBrokerToHostFrame[] {
    const revision = this.registry.revision;
    const records = this.registry.snapshotRecords();
    const snapshotId = randomUUID();
    const chunks: DesktopBrokerToHostFrame[] = [];
    for (let index = 0; index < records.length; index += this.snapshotChunkSize) {
      chunks.push({
        type: "desktop_broker_snapshot_chunk",
        brokerInstanceId: this.brokerInstanceId,
        snapshotId,
        revision,
        chunkIndex: chunks.length,
        records: records.slice(index, index + this.snapshotChunkSize),
      });
    }
    return [
      {
        type: "desktop_broker_snapshot_begin",
        brokerInstanceId: this.brokerInstanceId,
        snapshotId,
        revision,
        targetCount: records.length,
      },
      ...chunks,
      {
        type: "desktop_broker_snapshot_end",
        brokerInstanceId: this.brokerInstanceId,
        snapshotId,
        revision,
        chunkCount: chunks.length,
      },
    ];
  }

  async handleHostFrame(frame: DesktopHostToBrokerFrame): Promise<void> {
    switch (frame.type) {
      case "desktop_broker_ready":
        for (const snapshotFrame of this.createSnapshotFrames()) this.emit(snapshotFrame);
        return;
      case "desktop_broker_command":
        await this.forwardCommand(frame.request);
        return;
      case "desktop_broker_ask_response": {
        const registration = this.registry.resolve(frame.target);
        const key = this.askKey(frame.target, frame.response.requestId);
        const pending = this.pendingAsks.get(key);
        const expired = this.expiredAsks.get(key);
        const matchingExpiry = expired?.toolCallId === frame.response.toolCallId;
        const matchingPending = pending?.request.toolCallId === frame.response.toolCallId;
        const deadlineExceeded = matchingExpiry || (matchingPending && pending.request.deadlineAt <= Date.now());
        if (!pending || !matchingPending || pending.request.deadlineAt <= Date.now()) {
          this.emitAskResult(frame.target, {
            type: "desktop_ask_result",
            requestId: frame.response.requestId,
            toolCallId: frame.response.toolCallId,
            status: deadlineExceeded ? "failed" : "unknown",
            error: { code: deadlineExceeded ? "deadline_exceeded" : "target_unavailable", message: "desktop ask request unavailable" },
          });
          if (matchingExpiry) {
            clearTimeout(expired.timer);
            this.expiredAsks.delete(key);
          }
          return;
        }
        if (!registration?.transport.answerAsk) {
          this.emitAskResult(frame.target, {
            type: "desktop_ask_result",
            requestId: frame.response.requestId,
            toolCallId: frame.response.toolCallId,
            status: "unknown",
            error: { code: "target_unavailable", message: "desktop plugin target unavailable" },
          });
          return;
        }
        try {
          const result = await registration.transport.answerAsk(frame.response);
          const askResult: DesktopAskResult = result ?? {
            type: "desktop_ask_result",
            requestId: frame.response.requestId,
            toolCallId: frame.response.toolCallId,
            status: "accepted",
          };
          this.emitAskResult(frame.target, askResult);
          if (askResult.status === "accepted") this.clearAsk(key);
        } catch (error) {
          this.emitAskResult(frame.target, {
            type: "desktop_ask_result",
            requestId: frame.response.requestId,
            toolCallId: frame.response.toolCallId,
            status: "unknown",
            error: { code: "disconnected", message: error instanceof Error ? error.message : "desktop plugin disconnected" },
          });
          return;
        }
        return;
      }
      case "desktop_broker_ping":
        this.emit({ type: "desktop_broker_pong", nonce: frame.nonce });
        return;
      case "desktop_broker_error":
        return;
    }
  }

  private async forwardCommand(request: Extract<DesktopHostToBrokerFrame, { type: "desktop_broker_command" }>["request"]): Promise<void> {
    const registration = this.registry.resolve(request.target);
    const capability = request.operation.type as DesktopPluginCapability;
    if (!registration || !registration.capabilities.includes(capability)) {
      this.emitCommandResult(request.target, {
        type: "desktop_plugin_result",
        requestId: request.requestId,
        operation: request.operation.type,
        status: registration ? "failed" : "unknown",
        error: {
          code: registration ? "capability_mismatch" : "target_unavailable",
          message: registration ? "desktop plugin capability mismatch" : "desktop plugin target unavailable",
        },
      });
      return;
    }
    if (request.deadlineAt <= Date.now()) {
      this.emitCommandResult(request.target, {
        type: "desktop_plugin_result",
        requestId: request.requestId,
        operation: request.operation.type,
        status: "unknown",
        error: { code: "deadline_exceeded", message: "desktop plugin deadline exceeded" },
      });
      return;
    }
    try {
      this.emitCommandResult(request.target, await registration.transport.request(request));
    } catch (error) {
      const deadlineExceeded = error instanceof Error && error.message.includes("deadline exceeded");
      this.emitCommandResult(request.target, {
        type: "desktop_plugin_result",
        requestId: request.requestId,
        operation: request.operation.type,
        status: "unknown",
        error: {
          code: deadlineExceeded ? "deadline_exceeded" : "disconnected",
          message: deadlineExceeded ? "desktop plugin deadline exceeded" : "desktop plugin disconnected",
        },
      });
    }
  }

  private expireAsk(key: string): void {
    const pending = this.pendingAsks.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAsks.delete(key);
    const timer = setTimeout(() => this.expiredAsks.delete(key), 60_000);
    timer.unref?.();
    this.expiredAsks.set(key, { target: { ...pending.target }, requestId: pending.request.requestId, toolCallId: pending.request.toolCallId, timer });
  }

  private clearAsk(key: string): void {
    const expired = this.expiredAsks.get(key);
    if (expired) {
      clearTimeout(expired.timer);
      this.expiredAsks.delete(key);
    }
    const pending = this.pendingAsks.get(key);
    if (pending) clearTimeout(pending.timer);
    this.pendingAsks.delete(key);
  }

  private emitAskResult(target: DesktopPluginTarget, result: DesktopAskResult): void {
    const frame: DesktopBrokerAskResult = { type: "desktop_broker_ask_result", target: { ...target }, result };
    this.emit(frame);
  }

  private emitCommandResult(target: Extract<DesktopHostToBrokerFrame, { type: "desktop_broker_command" }>["request"]["target"], result: DesktopPluginResult): void {
    this.emit({ type: "desktop_broker_command_result", target, result });
  }

  private emit(frame: DesktopBrokerToHostFrame): void {
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // A disconnected Host must not corrupt Broker-owned state.
      }
    }
  }
}

export interface DesktopBrokerHostClientOptions {
  socketPath: string;
  secret: string;
  maxFrameBytes?: number;
  reconnectDelayMs?: number;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

/** Broker-side client for the Host-owned uplink. Plugin transports remain open across reconnects. */
export class DesktopBrokerHostClient {
  private connection: JsonLineConnection | undefined;
  private inFlightConnection: JsonLineConnection | undefined;
  private unsubscribeBroker: (() => void) | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;
  private closed = false;

  constructor(
    private readonly broker: DesktopBroker,
    private readonly options: DesktopBrokerHostClientOptions,
  ) {}

  start(): void {
    if (this.closed) throw new Error("desktop broker host client is closed");
    void this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.unsubscribeBroker?.();
    this.unsubscribeBroker = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.inFlightConnection?.close();
    this.inFlightConnection = undefined;
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting || this.connection) return;
    this.connecting = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(this.options.socketPath);
        let ready = false;
        let connection!: JsonLineConnection;
        const fail = (error: Error) => {
          connection.close(error);
          reject(error);
        };
        connection = new JsonLineConnection(
          socket,
          this.options.maxFrameBytes ?? 1024 * 1024,
          (raw) => {
            if (!ready) {
              if (!isDesktopHostToBrokerFrame(raw) || raw.type !== "desktop_broker_ready") {
                fail(new Error("desktop broker host ready required"));
                return;
              }
              if (this.closed) {
                connection.close(new Error("desktop broker host client is closed"));
                reject(new Error("desktop broker host client is closed"));
                return;
              }
              ready = true;
              this.inFlightConnection = undefined;
              this.connection = connection;
              for (const frame of this.broker.createSnapshotFrames()) connection.send(frame);
              for (const frame of this.broker.pendingAskFrames()) connection.send(frame);
              this.unsubscribeBroker = this.broker.subscribe((frame) => {
                try {
                  connection.send(frame);
                } catch {
                  connection.close(new Error("desktop broker host disconnected"));
                }
              });
              this.options.onConnected?.();
              resolve();
              return;
            }
            if (!isDesktopHostToBrokerFrame(raw)) {
              connection.close(new Error("invalid desktop broker host frame"));
              return;
            }
            void this.broker.handleHostFrame(raw);
          },
          (error) => {
            if (this.inFlightConnection === connection) this.inFlightConnection = undefined;
            if (this.connection === connection) {
              this.connection = undefined;
              this.unsubscribeBroker?.();
              this.unsubscribeBroker = undefined;
              this.options.onDisconnected?.();
            }
            if (!ready) reject(error ?? new Error("desktop broker host disconnected"));
            this.scheduleReconnect();
          },
        );
        this.inFlightConnection = connection;
        socket.once("connect", () => {
          try {
            connection.send({
              type: "desktop_broker_hello",
              protocolVersion: DESKTOP_BROKER_PROTOCOL_VERSION,
              brokerInstanceId: this.broker.brokerInstanceId,
              clientNonce: randomUUID(),
              secret: this.options.secret,
              releaseVersion: MOBILE_RELEASE_VERSION,
            });
          } catch (error) {
            fail(error instanceof Error ? error : new Error("desktop broker hello failed"));
          }
        });
        socket.once("error", (error) => {
          if (!ready) reject(error);
        });
      });
    } catch {
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.connection) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.options.reconnectDelayMs ?? 500);
  }
}
