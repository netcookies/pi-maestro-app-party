import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, chmod, unlink } from "node:fs/promises";
import net, { type Socket, type Server } from "node:net";
import type {
  DesktopPluginCapability,
  DesktopAskRequest,
  DesktopAskResponse,
  DesktopPluginClientFrame,
  DesktopPluginError,
  DesktopPluginFrame,
  DesktopPluginHello,
  DesktopPluginRequest,
  DesktopPluginResult,
  DesktopPluginServerFrame,
  DesktopPluginTarget,
} from "@maestro-mobile/shared";
import {
  DESKTOP_PLUGIN_PROTOCOL_VERSION,
  isDesktopPluginClientFrame,
  isDesktopPluginServerFrame,
  validateDesktopPluginClientFrame,
  validateDesktopPluginServerFrame,
} from "@maestro-mobile/shared";
import { DesktopPluginRegistry, type DesktopPluginTransport } from "./desktop-plugin-registry.js";

export const DEFAULT_DESKTOP_PLUGIN_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_DESKTOP_PLUGIN_HANDSHAKE_TIMEOUT_MS = 5_000;
export const DEFAULT_DESKTOP_PLUGIN_REQUEST_TIMEOUT_MS = 2_000;

export interface DesktopPluginIpcServerOptions {
  socketPath: string;
  secret: string;
  registry?: DesktopPluginRegistry;
  registryPath?: string;
  maxFrameBytes?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  onConnected?: (target: DesktopPluginTarget) => void;
  onAskRequest?: (target: DesktopPluginTarget, request: DesktopAskRequest) => void;
  onDisconnected?: (target: DesktopPluginTarget) => void;
}

export interface DesktopPluginIpcClientOptions {
  socketPath: string;
  secret: string;
  target: DesktopPluginTarget;
  capabilities: DesktopPluginCapability[];
  maxFrameBytes?: number;
  handshakeTimeoutMs?: number;
  onRequest: (request: DesktopPluginRequest) => Promise<DesktopPluginResult>;
  onAskResponse?: (response: DesktopAskResponse) => Promise<void>;
}

function sanitizedMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "desktop plugin operation failed";
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  const active = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(path);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => { probe.destroy(); resolve(false); });
  });
  if (active) throw new Error("desktop plugin socket already in use");
  await unlink(path).catch(() => undefined);
}


function isSameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function encodeFrame(frame: DesktopPluginFrame, maxFrameBytes: number): Buffer {
  const payload = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (payload.length > maxFrameBytes) throw new Error("desktop plugin frame too large");
  return payload;
}

class JsonLineConnection {
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly maxFrameBytes: number,
    private readonly onFrame: (frame: unknown) => void,
    private readonly onClosed: (error?: Error) => void,
  ) {
    socket.on("data", (data: Buffer) => this.receive(data));
    socket.once("error", (error) => this.close(error));
    socket.once("close", () => this.close());
  }

  send(frame: DesktopPluginFrame): void {
    if (this.closed) throw new Error("desktop plugin disconnected");
    this.socket.write(encodeFrame(frame, this.maxFrameBytes));
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClosed(error);
  }

  private receive(data: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > this.maxFrameBytes && this.buffer.indexOf(0x0a) < 0) {
      this.close(new Error("desktop plugin frame too large"));
      return;
    }
    while (true) {
      const end = this.buffer.indexOf(0x0a);
      if (end < 0) return;
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (line.length > this.maxFrameBytes) {
        this.close(new Error("desktop plugin frame too large"));
        return;
      }
      if (line.length === 0) continue;
      try {
        this.onFrame(JSON.parse(line.toString("utf8")));
      } catch {
        this.close(new Error("invalid desktop plugin frame"));
        return;
      }
    }
  }
}

class ServerTransport implements DesktopPluginTransport {
  private readonly pending = new Map<string, { resolve: (result: DesktopPluginResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;

  constructor(
    private readonly connection: JsonLineConnection,
    private readonly requestTimeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  request(request: DesktopPluginRequest): Promise<DesktopPluginResult> {
    if (this.closed) return Promise.reject(new Error("desktop plugin disconnected"));
    const remaining = request.deadlineAt - this.now();
    if (remaining <= 0) return Promise.reject(new Error("desktop plugin deadline exceeded"));
    const timeout = Math.min(remaining, this.requestTimeoutMs);
    return new Promise<DesktopPluginResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error("desktop plugin deadline exceeded"));
      }, timeout);
      this.pending.set(request.requestId, { resolve, reject, timer });
      try {
        this.connection.send(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error("desktop plugin disconnected"));
      }
    });
  }

  answerAsk(response: DesktopAskResponse): void {
    if (this.closed) throw new Error("desktop plugin disconnected");
    this.connection.send(response);
  }

  handle(frame: DesktopPluginServerFrame): void {
    if (frame.type === "desktop_plugin_result") {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.requestId);
      pending.resolve(frame);
    } else if (frame.type === "desktop_plugin_error" && frame.requestId) {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.requestId);
      pending.reject(new Error(frame.code));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("desktop plugin disconnected"));
    }
    this.pending.clear();
    this.connection.close();
  }
}

export class DesktopPluginIpcServer {
  readonly registry: DesktopPluginRegistry;
  private readonly server: Server;
  private readonly connections = new Set<JsonLineConnection>();
  private readonly targets = new Map<JsonLineConnection, DesktopPluginTarget>();
  private started = false;
  private closed = false;

  constructor(private readonly options: DesktopPluginIpcServerOptions) {
    if (!options.secret) throw new Error("desktop plugin secret is required");
    if (!options.socketPath) throw new Error("desktop plugin socket path is required");
    this.registry = options.registry ?? new DesktopPluginRegistry({ filePath: options.registryPath });
    this.server = net.createServer((socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.closed = false;
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
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    this.targets.clear();
    this.registry.clear();
    await this.registry.flush().catch(() => undefined);
    if (!this.started) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await unlink(this.options.socketPath).catch(() => undefined);
    this.started = false;
  }

  private accept(socket: Socket): void {
    const maxFrameBytes = this.options.maxFrameBytes ?? DEFAULT_DESKTOP_PLUGIN_MAX_FRAME_BYTES;
    let authenticated = false;
    let transport: ServerTransport | undefined;
    let target: DesktopPluginTarget | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let connection!: JsonLineConnection;
    const onClosed = () => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      this.connections.delete(connection);
      if (target) {
        this.registry.unregister(target, transport);
        this.targets.delete(connection);
        this.options.onDisconnected?.(target);
        void this.registry.flush().catch(() => undefined);
      }
    };
    const onFrame = (raw: unknown) => {
      if (!authenticated) {
        this.authenticate(connection, raw, (registeredTarget, registeredTransport) => {
          authenticated = true;
          target = registeredTarget;
          transport = registeredTransport;
          if (handshakeTimer) clearTimeout(handshakeTimer);
          this.targets.set(connection, registeredTarget);
          this.options.onConnected?.(registeredTarget);
        });
        return;
      }
      if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "desktop_plugin_goodbye") {
        connection.close(new Error("desktop plugin goodbye"));
        return;
      }
      if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "desktop_ask_request") {
        if (isDesktopPluginClientFrame(raw) && raw.type === "desktop_ask_request" && target) {
          this.options.onAskRequest?.(target, raw);
          return;
        }
        this.sendError(connection, "invalid_frame", undefined);
        return;
      }
      if (!isDesktopPluginServerFrame(raw)) {
        this.sendError(connection, "invalid_frame", undefined);
        connection.close(new Error("invalid desktop plugin server frame"));
        return;
      }
      transport?.handle(validateDesktopPluginServerFrame(raw));
    };
    connection = new JsonLineConnection(socket, maxFrameBytes, onFrame, onClosed);
    this.connections.add(connection);
    handshakeTimer = setTimeout(() => {
      this.sendError(connection, "authentication_failed", undefined);
      connection.close(new Error("desktop plugin handshake timeout"));
    }, this.options.handshakeTimeoutMs ?? DEFAULT_DESKTOP_PLUGIN_HANDSHAKE_TIMEOUT_MS);
  }

  private authenticate(
    connection: JsonLineConnection,
    raw: unknown,
    onAuthenticated: (target: DesktopPluginTarget, transport: ServerTransport) => void,
  ): void {
    if (!isDesktopPluginClientFrame(raw) || raw.type !== "desktop_plugin_hello") {
      this.sendError(connection, "invalid_frame", undefined);
      connection.close(new Error("desktop plugin hello required"));
      return;
    }
    let hello: DesktopPluginHello;
    try {
      hello = validateDesktopPluginClientFrame(raw) as DesktopPluginHello;
    } catch {
      this.sendError(connection, "protocol_version_unsupported", undefined);
      connection.close(new Error("desktop plugin protocol unsupported"));
      return;
    }
    if (!isSameSecret(hello.secret, this.options.secret)) {
      this.sendError(connection, "authentication_failed", undefined);
      connection.close(new Error("desktop plugin authentication failed"));
      return;
    }
    const target: DesktopPluginTarget = {
      sessionId: hello.sessionId,
      endpointId: hello.endpointId,
      normalizedCwd: hello.normalizedCwd,
      processGeneration: hello.processGeneration,
    };
    const transport = new ServerTransport(
      connection,
      this.options.requestTimeoutMs ?? DEFAULT_DESKTOP_PLUGIN_REQUEST_TIMEOUT_MS,
    );
    connection.send({ type: "desktop_plugin_challenge", protocolVersion: DESKTOP_PLUGIN_PROTOCOL_VERSION, nonce: randomBytes(16).toString("hex") });
    connection.send({ type: "desktop_plugin_ready", protocolVersion: DESKTOP_PLUGIN_PROTOCOL_VERSION, endpointId: hello.endpointId, capabilities: hello.capabilities });
    this.registry.register({ target, capabilities: hello.capabilities, transport });
    void this.registry.flush().catch(() => undefined);
    onAuthenticated(target, transport);
  }

  private sendError(connection: JsonLineConnection, code: DesktopPluginError["code"], requestId: string | undefined): void {
    try { connection.send({ type: "desktop_plugin_error", ...(requestId ? { requestId } : {}), code, message: code }); } catch { /* socket already closed */ }
  }
}

export class DesktopPluginIpcClient {
  private connection: JsonLineConnection | undefined;
  private ready: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: DesktopPluginIpcClientOptions) {}

  async connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.options.socketPath);
      let authenticated = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let connection!: JsonLineConnection;
      const finishError = (error: Error) => {
        if (timer) clearTimeout(timer);
        reject(error);
        connection.close(error);
      };
      connection = new JsonLineConnection(socket, this.options.maxFrameBytes ?? DEFAULT_DESKTOP_PLUGIN_MAX_FRAME_BYTES, (raw) => {
        if (!authenticated) {
          if (!isDesktopPluginServerFrame(raw)) return finishError(new Error("invalid desktop plugin server frame"));
          const frame = validateDesktopPluginServerFrame(raw);
          if (frame.type === "desktop_plugin_ready") {
            authenticated = true;
            if (timer) clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (isDesktopPluginClientFrame(raw) && raw.type === "desktop_ask_response") {
          const response = validateDesktopPluginClientFrame(raw) as DesktopAskResponse;
          void this.options.onAskResponse?.(response);
          return;
        }
        if (isDesktopPluginClientFrame(raw) && raw.type === "desktop_plugin_request") {
          let request: DesktopPluginRequest;
          try {
            request = validateDesktopPluginClientFrame(raw) as DesktopPluginRequest;
          } catch {
            connection.send({ type: "desktop_plugin_error", code: "invalid_frame", message: "invalid request" });
            return;
          }
          const target = this.options.target;
          const targetMatches = request.target.sessionId === target.sessionId
            && request.target.endpointId === target.endpointId
            && request.target.normalizedCwd === target.normalizedCwd
            && request.target.processGeneration === target.processGeneration;
          if (!targetMatches) {
            connection.send({ type: "desktop_plugin_error", requestId: request.requestId, code: "target_mismatch", message: "target_mismatch" });
            return;
          }
          const capability = request.operation.type === "follow_up" ? "follow_up" : request.operation.type;
          if (!this.options.capabilities.includes(capability)) {
            connection.send({ type: "desktop_plugin_error", requestId: request.requestId, code: "capability_mismatch", message: "capability_mismatch" });
            return;
          }
          if (request.deadlineAt <= Date.now()) {
            connection.send({ type: "desktop_plugin_error", requestId: request.requestId, code: "deadline_exceeded", message: "deadline_exceeded" });
            return;
          }
          connection.send({ type: "desktop_plugin_receipt", requestId: request.requestId, operation: request.operation.type, status: "accepted" });
          void this.options.onRequest(request).then((result) => {
            connection.send({ ...result, requestId: request.requestId, operation: request.operation.type });
          }).catch((error: unknown) => {
            try {
              connection.send({ type: "desktop_plugin_result", requestId: request.requestId, operation: request.operation.type, status: "failed", error: { code: "plugin_command_failed", message: sanitizedMessage(error) } });
            } catch {
              // disconnect is already the terminal outcome for this request
            }
          });
          return;
        }
        if (isDesktopPluginServerFrame(raw)) {
          const frame = validateDesktopPluginServerFrame(raw);
          if (frame.type === "desktop_plugin_error") return finishError(new Error(frame.code));
        } else {
          finishError(new Error("invalid desktop plugin frame"));
        }
      }, (error) => {
        if (!authenticated) reject(error ?? new Error("desktop plugin disconnected"));
      });
      this.connection = connection;
      timer = setTimeout(() => finishError(new Error("desktop plugin handshake timeout")), this.options.handshakeTimeoutMs ?? DEFAULT_DESKTOP_PLUGIN_HANDSHAKE_TIMEOUT_MS);
      socket.once("connect", () => {
        try {
          const target = this.options.target;
          connection.send({
            type: "desktop_plugin_hello",
            protocolVersion: DESKTOP_PLUGIN_PROTOCOL_VERSION,
            endpointId: target.endpointId,
            sessionId: target.sessionId,
            normalizedCwd: target.normalizedCwd,
            processGeneration: target.processGeneration,
            capabilities: this.options.capabilities,
            clientNonce: randomBytes(16).toString("hex"),
            secret: this.options.secret,
          });
        } catch (error) {
          finishError(error instanceof Error ? error : new Error("desktop plugin hello failed"));
        }
      });
    });
    return this.ready;
  }

  async sendAskRequest(request: DesktopAskRequest): Promise<void> {
    await this.connect();
    if (this.closed || !this.connection) throw new Error("desktop plugin disconnected");
    this.connection.send(request);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection?.close();
  }

  get isConnected(): boolean {
    return Boolean(this.connection) && !this.closed;
  }
}
