/**
 * HostClient — 移动端连接 Host 的 WebSocket 客户端
 *
 * 职责：
 * - 建立/重连 WS（指数退避）
 * - 解析 HostEvent 并分发
 * - 发送 ClientCommand 并匹配响应（command_result）
 * - 维护连接状态（供 UI 显示）
 */
import type {
  ClientCommand,
  HostEvent,
  SessionSnapshot,
  ExtensionUiResponse,
} from "@maestro-mobile/shared";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface HostClientOptions {
  url: string;
  token?: string;
  /** 重连间隔基数 ms（默认 1000） */
  reconnectBaseMs?: number;
  /** 最大重连间隔 ms（默认 15000） */
  reconnectMaxMs?: number;
  /** 测试注入的 WebSocket 工厂 */
  wsFactory?: (url: string, token?: string) => WebSocketLike;
  onEvent?: (event: HostEvent) => void;
  onStateChange?: (state: ConnectionState) => void;
}

/** 可测试的 WebSocket 抽象（React Native 的 WebSocket 与浏览器一致） */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export const WS_OPEN = 1;

export class HostClient {
  private ws: WebSocketLike | null = null;
  private state: ConnectionState = "disconnected";
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private reconnectAttempt = 0;
  /** 连接代次：旧 socket 回调不接管新连接状态 */
  private socketGeneration = 0;
  private connectedAt = 0;
  private connectStartedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** 鉴权失败（token 错误）：重连无意义，停止退避并把原因报给 UI */
  private authFailed = false;
  private pendingCommands = new Map<string, {
    resolve(result: unknown): void;
    reject(error: Error): void;
  }>();
  private commandSeq = 0;

  constructor(private readonly options: HostClientOptions) {
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15000;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === "connected";
  }

  /** 连接（首次或手动重连） */
  connect(): void {
    this.closed = false;
    this.authFailed = false;
    this.openSocket();
  }

  /** 主动关闭（用户退出） */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setState("disconnected");
    // 拒绝所有挂起命令
    for (const { reject } of this.pendingCommands.values()) {
      reject(new Error("HostClient closed"));
    }
    this.pendingCommands.clear();
  }

  /** 发送命令并等待响应 */
  sendCommand(command: ClientCommand & { id?: string }, timeoutMs = 30_000): Promise<unknown> {
    const id = command.id ?? `cmd-${++this.commandSeq}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Command timeout: ${payload.type}`));
      }, timeoutMs);
      this.pendingCommands.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.sendRaw(JSON.stringify(payload));
    });
  }

  /** 发送扩展 UI 响应 */
  respondExtensionUi(sessionId: string, requestId: string, response: ExtensionUiResponse): Promise<unknown> {
    return this.sendCommand({
      type: "extension_ui_response",
      sessionId,
      requestId,
      response,
    });
  }

  /** 获取快照 */
  getSnapshot(sessionId: string): Promise<SessionSnapshot> {
    return this.sendCommand({ type: "get_snapshot", sessionId }) as Promise<SessionSnapshot>;
  }

  private openSocket(): void {
    this.setState(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const factory = this.options.wsFactory
      ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    // token 用 searchParams 拼接：url 已有 query 时也能正确连接
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
      this.scheduleReconnect();
      return;
    }
    this.connectStartedAt = Date.now();
    // 旧 socket 延迟回调不再接管状态（连接代次防护）
    const generation = ++this.socketGeneration;
    this.ws = ws;

    ws.onopen = () => {
      if (generation !== this.socketGeneration || this.closed) return;
      // 连接需稳定保持 30s 才清零退避，防握手后反复断开退化为每秒重试
      this.connectedAt = Date.now();
      this.setState("connected");
      setTimeout(() => {
        if (generation === this.socketGeneration && this.ws === ws && Date.now() - this.connectedAt >= 30_000) {
          this.reconnectAttempt = 0;
        }
      }, 30_000);
    };

    ws.onmessage = (data) => {
      if (generation !== this.socketGeneration) return;
      this.handleRawMessage(data.data);
    };

    ws.onclose = () => {
      if (this.closed || generation !== this.socketGeneration) return;
      // RN WebSocket 拿不到 HTTP 升级状态码；启发式：开启后从未 onopen 且 2s 内即被断 → 大概率 401（token 错误）。
      // 标记 authFailed 停止重连（重试只会持续 401），让 UI 显示明确的 token 错误提示。
      if (this.state !== "connected" && Date.now() - this.connectStartedAt < 2_000 && this.reconnectAttempt >= 1) {
        this.authFailed = true;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose 会跟随，这里不重复处理
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.authFailed) {
      // token 错误：停止重连，状态停在 disconnected，错误由 lastError 通道提示
      this.setState("disconnected");
      this.options.onEvent?.({ type: "error", message: "token 校验失败 —— 在 PC 终端执行 /maestro-mobile qr 重新扫码配对" } as never);
      return;
    }
    this.setState("reconnecting");
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempt, this.reconnectMaxMs);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.openSocket();
    }, delay);
  }

  private handleRawMessage(raw: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message && typeof message === "object") {
      const m = message as Record<string, unknown>;
      if (m.type === "command_result") {
        this.resolveCommand(m);
        return;
      }
      if (m.type === "snapshot" && m.snapshot) {
        this.resolveCommand(m, m.snapshot);
        return;
      }
      if (typeof m.type === "string" && typeof m.seq === "number") {
        this.options.onEvent?.(message as HostEvent);
        return;
      }
    }
  }

  private resolveCommand(message: Record<string, unknown>, value?: unknown): void {
    const inReplyTo = typeof message.in_reply_to === "string" ? message.in_reply_to : "";
    const pending = this.pendingCommands.get(inReplyTo);
    if (!pending) return;
    this.pendingCommands.delete(inReplyTo);
    if (message.ok === true) {
      pending.resolve(value ?? message.result ?? null);
    } else {
      const err = message.error as { code?: string; message?: string } | undefined;
      pending.reject(new Error(err?.message ?? err?.code ?? "Command failed"));
    }
  }

  private sendRaw(data: string): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(data);
    } else {
      // 未连接：立即拒绝命令（重连后客户端应重试）
      for (const { reject } of this.pendingCommands.values()) {
        reject(new Error("Not connected"));
      }
      this.pendingCommands.clear();
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}