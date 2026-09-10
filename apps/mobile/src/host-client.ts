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
  /**
   * 连接层错误（命令因断连而未被确认）回调。rejection 仍会冒泡给调用方，
   * 本回调只负责把错误送进 store 的 lastError 通道：app/session.tsx:151 注释声称
   * 「错误由 store.lastError 提示」，但 lastError 此前只由 host 推的事件写入，
   * 客户端本地 reject 实际进不了 reducer → UI 静默。
   */
  onConnectionError?: (message: string) => void;
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

/**
 * 连接层错误：命令未被确认是否已由 Host 执行（区别于 Host 明确回给的业务失败）。
 * 调用方可据此区分「失败」与「需重连后核对状态」。
 * 不会把仍在 Host 正常执行的 prompt 误判为业务失败：服务端 runner.prompt() 在 preflight
 * 受理时即 resolve 并回 ack（session-runner.ts:110-120 + mobile-host-server.ts:732），
 * 因此断连时仍挂在 pending 的命令处于「未确认」而非「已失败」态。
 */
export class CommandConnectionLostError extends Error {
  readonly code = "connection_lost";
  /** 断连时该命令是否已交给 socket（仅供诊断，不作为成功/失败依据） */
  readonly maybeExecuted: boolean;

  constructor(commandType: string, maybeExecuted: boolean) {
    super(`Connection lost before response (${commandType})`);
    this.name = "CommandConnectionLostError";
    this.maybeExecuted = maybeExecuted;
  }
}

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
  /** 快速失败疑似鉴权问题（待 HTTP 探测确认） */
  private suspectAuthFailure = false;
  private pendingCommands = new Map<string, {
    resolve(result: unknown): void;
    reject(error: Error): void;
    commandType: string;
    maybeExecuted: boolean;
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
    // 拒绝所有挂起命令（文案与历史一致）
    this.rejectAllPending("closed");
  }

  /**
   * 以连接层错误 settle 全部在途命令。保留每条命令自身的 30s timeout 作为兜底，
   * 本方法只在能确定「响应永不会到达」时提前失败（因此不删超时，只把它降级为兜底）。
   */
  private rejectAllPending(reason: "connection_lost" | "closed" | "not_connected"): void {
    if (this.pendingCommands.size === 0) return;
    const pending = [...this.pendingCommands.values()];
    this.pendingCommands.clear();
    const errors = pending.map((cmd) =>
      reason === "connection_lost"
        ? new CommandConnectionLostError(cmd.commandType, cmd.maybeExecuted)
        : new Error(reason === "closed" ? "HostClient closed" : "Not connected"),
    );
    for (let i = 0; i < pending.length; i++) {
      pending[i].reject(errors[i]);
    }
    // 只报首条 + 汇总数，避免断线瞬间刷屏覆盖 lastError
    if (reason === "connection_lost") {
      this.options.onConnectionError?.(
        pending.length > 1
          ? `${errors[0].message}（另有 ${pending.length - 1} 条命令状态未知）`
          : errors[0].message,
      );
    }
  }

  /** 发送命令并等待响应 */
  sendCommand(command: ClientCommand & { id?: string }, timeoutMs = 30_000): Promise<unknown> {
    const id = command.id ?? `cmd-${++this.commandSeq}`;
    const payload = { ...command, id };
    // 发送前判定是否已交给 socket：断连时区分「可能已执行」与「肯定未执行」
    const maybeExecuted = this.ws?.readyState === WS_OPEN;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Command timeout: ${payload.type}`));
      }, timeoutMs);
      this.pendingCommands.set(id, {
        commandType: payload.type,
        maybeExecuted,
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
      // 意外断连：立即以可区分错误 settle 在途命令。此前只重连不清 pending，
      // 它们会各自挂满 30s timer 才报 timeout（UI 表现为无响应），且 timeout 文案无法区分
      // 「命令失败」与「连接丢失、执行状态未知」。手动 close() 已由上方 this.closed 守卫排除。
      this.rejectAllPending("connection_lost");
      // 快速失败（从未 onopen 且 <2s）：标记疑似鉴权问题，由 verifyAuthFailure 用 HTTP 探测确认后才停连
      if (this.state !== "connected" && Date.now() - this.connectStartedAt < 2_000 && this.reconnectAttempt >= 1) {
        this.suspectAuthFailure = true;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose 会跟随，这里不重复处理
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    // RN WebSocket 拿不到 HTTP 升级状态码；「从未 onopen 且反复快速被断」既可能是 token 错（401），
    // 也可能只是 host 未启动/网络不通（refused）。用 HTTP /api/health 探测区分：
    //   401 = 服务在但 token 错 → authFailed 停止重连；其它 = 网络问题 → 继续退避重连。
    if (this.suspectAuthFailure) {
      this.suspectAuthFailure = false;
      void this.verifyAuthFailure();
    }
    this.setState("reconnecting");
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempt, this.reconnectMaxMs);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.openSocket();
    }, delay);
  }

  /** HTTP 探测 /api/health：401 才是真 token 错误（探测期间照常退避重连，不阻塞） */
  private async verifyAuthFailure(): Promise<void> {
    try {
      const httpBase = this.options.url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/ws$/, "").replace(/\/$/, "");
      const res = await fetch(`${httpBase}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (this.closed || this.state === "connected") return;
      if (res.status === 401) {
        this.authFailed = true;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.setState("disconnected");
        this.options.onEvent?.({ type: "error", message: "token 校验失败 —— 在 PC 终端执行 /maestro-mobile qr 重新扫码配对" } as never);
      }
      // 200/其它状态 = 服务在且 token 未启用或路径异常，不做 auth 判定，退避重连继续
    } catch {
      // fetch 失败 = 网络不通，不是 token 错，继续重连
    }
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
      // 未连接：立即拒绝命令（重连后客户端应重试）；含本次刚入队的命令，与历史行为一致
      this.rejectAllPending("not_connected");
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}