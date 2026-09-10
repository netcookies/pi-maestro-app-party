import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { RawData } from "ws";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { readFile, open, stat } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type {
  ClientCommand,
  HostEvent,
  HostSessionList,
  HostSessionSummary,
  HostStatus,
  SessionSnapshot,
} from "@maestro-mobile/shared";
import type { HostController } from "../host-controller.js";
import { projectMonitorState } from "../monitor-projection.js";
import type { RuntimeFactory } from "../types.js";
import type { LiveSessionList } from "../live-sessions.js";
import { readSettingsOverview, updateSettingsJson } from "../maestro-settings.js";
import { validateClientCommand } from "@maestro-mobile/shared";
import { HostSessionListService } from "./helpers.js";

export interface MobileHostServerOptions {
  token?: string;
  corsOrigin?: string;
  /** WS Origin 额外白名单（除 loopback 与绑定 host 外的受信来源，如显式 LAN IP） */
  allowedOrigins?: string[];
  /** 入站单帧上限（字节）。默认 8MB；测试可注入小值验证超限隔离 */
  maxPayload?: number;
  /** 背压软高水位（字节），默认 2MB */
  highWaterMarkBytes?: number;
  /** 背压硬上限（字节），默认 8MB */
  hardLimitBytes?: number;
  /** required 帧持续越阈的宽限期（ms），默认 5000 */
  slowGraceMs?: number;
  /** 心跳周期（ms）：每周期 ping，下周期仍无 pong 则 terminate。默认 30s；测试可注入小值 */
  heartbeatIntervalMs?: number;
}

interface ClientSocket {
  id: string;
  ws: WebSocket;
  /** in-flight 命令数（并发限制） */
  inflight: number;
  /** 已进入关闭流程：发送出口短路 + 背压关断幂等 */
  closing: boolean;
  /** 被丢弃的 best_effort 帧计数（观测用，60s 节流汇总） */
  droppedFrames: number;
  lastDropLogAt: number;
  /** 背压宽限：首次越阈时间戳，持续越阈达宽限期才 close，避免突发抖动误杀 */
  slowSince: number;
  /** 心跳存活标记：ping 前清零，收到 pong 置回；下周期仍 false 则 terminate */
  alive: boolean;
}

/**
 * MobileHostServer — 移动端直连服务器（HTTP REST + WebSocket）
 *
 * 直连模式：同一局域网/同机，无 relay。
 * - WS: /ws 实时事件流 + 客户端命令
 * - HTTP: /api/health, /api/status, /api/sessions, /api/maestro
 *
 * 安全：token 可选（Bearer header 或 ?token=）
 */
export class MobileHostServer {
  private readonly server: Server;
  private readonly webSocketServer: WebSocketServer;
  private readonly clients = new Set<ClientSocket>();
  /** 单客户端并发命令上限：超过则拒绝，防命令洪泛（DoS） */
  private static readonly MAX_CONNECTIONS = 32;
  private static readonly MAX_CONCURRENT_COMMANDS = 8;
  /** 软高水位：best_effort 帧越阈即丢；required 帧持续越阈达宽限期才断线 */
  private static readonly HIGH_WATER_MARK_BYTES = 2 * 1024 * 1024;
  /** 硬上限：required 帧遇到即断线。宽限期只容忍短突发；若无硬顶，对端 TCP 窗口卡死时
   * 高码率广播可使队列在宽限窗口内膨胀到百 MB 级——内存有界靠的是硬顶，不是宽限期 */
  private static readonly HARD_LIMIT_BYTES = 8 * 1024 * 1024;
  private static readonly SLOW_GRACE_MS = 5_000;
  private static readonly DROP_LOG_INTERVAL_MS = 60_000;
  private unsubscribeController: (() => void) | undefined;
  /** listen() 等待中的错误回调；非空表示正在绑定端口 */
  private listenError: ((error: Error) => void) | undefined;
  private boundHost = "0.0.0.0";
  private readonly hostSessionList = new HostSessionListService({
    indexPath: join(homedir(), ".pi", "agent", "mobile-session-index.json"),
  });
  /** 背压参数（构造时从 options 解析，默认取静态常量） */
  private readonly highWaterMarkBytes: number;
  private readonly hardLimitBytes: number;
  private readonly slowGraceMs: number;

  constructor(
    private readonly controller: HostController,
    private readonly options: MobileHostServerOptions = {},
  ) {
    this.webSocketServer = new WebSocketServer({ noServer: true, maxPayload: this.options.maxPayload ?? 8 * 1024 * 1024 });
    this.highWaterMarkBytes = this.options.highWaterMarkBytes ?? MobileHostServer.HIGH_WATER_MARK_BYTES;
    this.hardLimitBytes = this.options.hardLimitBytes ?? MobileHostServer.HARD_LIMIT_BYTES;
    this.slowGraceMs = this.options.slowGraceMs ?? MobileHostServer.SLOW_GRACE_MS;
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    // 常驻单一 error 入口：启动期错误只交给 listen() 的 reject，以免与友好提示重复打印原始错误；
    // listen 成功后的 server error（EMFILE 等）无监听者时会以 uncaughtException 崩掉守护进程，故仅记录不抛出。
    this.server.on("error", (error) => {
      const pending = this.listenError;
      this.listenError = undefined;
      if (pending) pending(error);
      else console.error("[maestro-mobile] http server error:", error);
    });

    this.webSocketServer.on("connection", (ws) => {
      if (this.clients.size >= MobileHostServer.MAX_CONNECTIONS) {
        console.warn(`[maestro-mobile] ws rejected: too many connections (limit=${MobileHostServer.MAX_CONNECTIONS})`);
        ws.close(1013, "too many connections");
        return;
      }
      const client: ClientSocket = { id: crypto.randomUUID(), ws, inflight: 0, closing: false, droppedFrames: 0, lastDropLogAt: 0, slowSince: 0, alive: true };
      this.clients.add(client);
      // 故障隔离到连接粒度（本 run 主根因）：此前无 error listener，超限/非法帧的 error 事件直接变
      // uncaughtException → cli fatal() → 整个 host 退出（单手机一帧崩掉所有客户端）。现在只断该连接，
      // 其余连接无感。listener 必须先于任何 send 注册。
      ws.on("error", (error: Error & { code?: string }) => {
        // 注意：ws 在协议错误路径（receiverOnError）已同步发过 close 帧，此处不得 terminate，
        // 否则抢掉 1009 通知，客户端只能看到裸 TCP 断。幂等 closing 标记下走 graceful 重复 close（无副作用）。
        console.error(`[maestro-mobile] ws error client=${client.id} code=${error.code ?? "-"} message=${sanitizeWsErrorMessage(error.message)} (isolated)`);
        this.closeClient(client, "ws_error");
      });
      // 活性由标准 ping/pong 心跳维护（见 startHeartbeat）：客户端栈（RN OkHttp/浏览器/Node ws）
      // 均自动应答 pong，无需改协议。半开连接、死 socket 在下个周期被 terminate，
      // 也封住 close() 等失联连接 graceful close 的≈30s 悬挂。
      ws.on("pong", () => {
        client.alive = true;
      });
      ws.on("message", (data) => {
        if (client.inflight >= MobileHostServer.MAX_CONCURRENT_COMMANDS) {
          this.sendError(client, "too_many_commands", "");
          return;
        }
        client.inflight++;
        // .catch 不可省：void 链上任何 rejection（含未来新增分支）都会经 unhandledRejection 冒到 cli fatal() 退进程
        void this.handleClientMessage(client, data)
          .catch((error: unknown) => {
            console.error(`[maestro-mobile] ws command crashed client=${client.id}:`, error instanceof Error ? sanitizeWsErrorMessage(error.message) : error);
          })
          .finally(() => {
            client.inflight--;
          });
      });
      ws.on("close", (code: number, reason: Buffer) => {
        client.closing = true;
        if (client.droppedFrames > 0) {
          console.warn(`[maestro-mobile] ws closed client=${client.id} code=${code} droppedTotal=${client.droppedFrames}`);
        } else if (code !== 1000 && code !== 1001) {
          console.warn(`[maestro-mobile] ws closed client=${client.id} code=${code} reason=${sanitizeWsErrorMessage(reason.toString()).slice(0, 60)}`);
        }
        this.clients.delete(client);
      });
      // P2-1：host_status 契约是 status: string；HostStatus 对象走独立的 host_info 事件
      this.sendFrame(client, { type: "host_status", status: "connected", seq: 0 }, "required");
      this.sendFrame(client, { type: "host_info", info: this.controller.getStatus(), seq: 0 }, "required");
    });

    this.unsubscribeController = this.controller.onEvent((event) => {
      let payload: string;
      try {
        payload = JSON.stringify(event);
      } catch (error) {
        // 序列化失败（循环引用/BigInt）属事件自身缺陷：只记一次不抛出（controller 侧已有 per-listener 防护，
        // 但本 listener 抛错会使本事件对其后客户端丢失——提前 return 避免半途截断）
        console.error(`[maestro-mobile] ws broadcast serialize failed type=${(event as { type?: string }).type ?? "?"}:`, error instanceof Error ? error.message : error);
        return;
      }
      // 协议层可丢性（packages/shared/src/protocol.ts:324-328）：只有 timeline_delta 声明「尚不存在可忽略，
      // 终态由 timeline_item 补齐」。其余事件无 server 侧重放保证，一律 required（宁断不默丢）。
      const delivery = event.type === "timeline_delta" ? "best_effort" : "required";
      for (const client of [...this.clients]) {
        this.sendFrame(client, payload, delivery, event.type);
      }
    });
  }

  private remoteOf(ws: WebSocket): string {
    return (ws as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? "-";
  }

  /** 心跳周期句柄 */
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * 服务端心跳：每周期对无响应的连接 terminate（半开/死 socket），有响应则 ping。
   * 替代此前没用的 ws.setTimeout（WebSocket 对象无此方法）；也让 close():「graceful 等待」不再被失联连接拖≈30s。
   */
  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of [...this.clients]) {
        if (!client.alive) {
          console.warn(`[maestro-mobile] ws heartbeat lost client=${client.id} remote=${this.remoteOf(client.ws)} → terminate`);
          this.closeClient(client, "heartbeat_lost");
          continue;
        }
        client.alive = false;
        try {
          client.ws.ping();
        } catch {
          this.closeClient(client, "ping_failed");
        }
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.(); // 不阻止进程退出
  }

  /**
   * 单一发送出口（故障隔离 + 背压收口）：所有 WS 写出必须经此，不得直接 ws.send。
   * - required（command_result/握手/协议错误/timeline_item/session_updated/raw_event/…）：
   *   越阈不静默丢；持续越阈达宽限期 close(1013)，由客户端重连 + P2-2 snapshot 补拉自愈。
   *   不自研排队/drain 补发：消除 close×drain 竞态，局域网工具不值得该复杂度。
   * - best_effort（仅 timeline_delta）：越阈直接丢弃并计数，终态由后续 timeline_item 补齐，不断线。
   */
  private sendFrame(client: ClientSocket, message: object | string, delivery: "required" | "best_effort", kind = "object"): boolean {
    if (client.closing || client.ws.readyState !== client.ws.OPEN) return false;
    let payload: string;
    try {
      payload = typeof message === "string" ? message : JSON.stringify(message);
    } catch (error) {
      console.error(`[maestro-mobile] ws sendFrame serialize failed kind=${kind} client=${client.id}:`, error instanceof Error ? error.message : error);
      return false;
    }
    const buffered = client.ws.bufferedAmount;
    if (buffered >= this.hardLimitBytes) {
      // 硬顶：无论何种投递都先断线；required 走到这里绝不静默丢数据（断线重连才是既定自愈路径）
      console.warn(`[maestro-mobile] ws buffer hard limit client=${client.id} remote=${this.remoteOf(client.ws)} buffered=${buffered} dropped=${client.droppedFrames} → close(1013)`);
      this.closeClient(client, "slow_consumer");
      return false;
    }
    if (buffered >= this.highWaterMarkBytes) {
      if (delivery === "best_effort") {
        client.droppedFrames++;
        const now = Date.now();
        if (now - client.lastDropLogAt >= MobileHostServer.DROP_LOG_INTERVAL_MS) {
          client.lastDropLogAt = now;
          console.warn(`[maestro-mobile] ws slow consumer client=${client.id} remote=${this.remoteOf(client.ws)} buffered=${buffered} droppedSinceLastLog (best_effort frames, continuing)`);
        }
        return false;
      }
      if (!client.slowSince) {
        client.slowSince = Date.now();
      } else if (Date.now() - client.slowSince >= this.slowGraceMs) {
        // required 帧无法送达：与其默默丢，不如在可重连边界上断线（1013 = retryable，与满载拒绝同码）
        console.warn(`[maestro-mobile] ws slow consumer exceeded grace client=${client.id} remote=${this.remoteOf(client.ws)} buffered=${buffered} → close(1013)`);
        this.closeClient(client, "slow_consumer");
      }
      // 宽限期内：不丢、不断，交给 ws 内部缓冲（软/硬双阈值 + 5s 宽限，驻留有界）
      return this.rawSend(client, payload);
    }
    client.slowSince = 0;
    return this.rawSend(client, payload);
  }

  private rawSend(client: ClientSocket, payload: string): boolean {
    try {
      client.ws.send(payload);
      return true;
    } catch (error) {
      // 理论上仅 CONNECTING 态会同步抛（服务端不可达）；保留隔离防未来分支变化
      console.error(`[maestro-mobile] ws send threw client=${client.id}:`, error instanceof Error ? error.message : error);
      this.closeClient(client, "send_failed");
      return false;
    }
  }

  /**
   * 幂等关闭：只由首个调用者真正关。默认 graceful close（让 close 帧送达，客户端能看到 1013/reason）；
   * ws 内部已在协议错误路径自行发过 close 帧（receiverOnError），重复 close 无副作用。
   * heartbeat_lost/ping_failed 等对端已死的场景直接 terminate 强制拆。
   */
  private closeClient(client: ClientSocket, reason: string): void {
    if (client.closing) return;
    client.closing = true;
    this.clients.delete(client);
    try {
      if (reason === "heartbeat_lost" || reason === "ping_failed" || reason === "send_failed") {
        client.ws.terminate();
      } else {
        client.ws.close(1013, reason);
        // graceful close 对端不应答时不等≈30s closeTimeout：2s 后强制拆
        setTimeout(() => {
          try { client.ws.terminate(); } catch { /* 已清理 */ }
        }, 2_000).unref?.();
      }
    } catch (error) {
      console.error(`[maestro-mobile] ws close failed client=${client.id} reason=${reason}:`, error instanceof Error ? error.message : error);
    }
  }

  listen(port: number, hostname = "0.0.0.0"): Promise<void> {
    this.boundHost = hostname;
    this.startHeartbeat(this.options.heartbeatIntervalMs ?? 30_000);
    return new Promise((resolve, reject) => {
      // EADDRINUSE / EACCES / 非法绑定地址都以 server 的 error 事件产生。此前无监听者：
      // 该 Promise 永不 settle，错误以 uncaughtException 裸崩（而此时 cli 的 handler 尚未注册）。
      this.listenError = reject;
      this.server.listen(port, hostname, () => {
        this.listenError = undefined;
        resolve();
      });
    });
  }

  address(): { port: number } {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server is not listening on a TCP port");
    }
    return { port: address.port };
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.unsubscribeController?.();
    for (const client of this.clients) {
      client.ws.close();
    }
    this.clients.clear();
    this.webSocketServer.close();
    // 失联/半开连接的 graceful close 帧无应答，wss.close 会等 ws 内部≈30s closeTimeout：
    // 优雅等待有界（3s），超时后强拆残留 socket，shutdown 不再悬挂。
    await new Promise<void>((resolve) => {
      const forceSockets = () => {
        for (const socket of this.webSocketServer.clients) {
          try { socket.terminate(); } catch { /* 已断开 */ }
        }
      };
      const timer = setTimeout(() => { forceSockets(); resolve(); }, 3_000);
      this.webSocketServer.once("close", () => { clearTimeout(timer); resolve(); });
    });
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      applyCorsHeaders(response, this.options.corsOrigin);
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/pair-short") {
        // 两段式配对：短码换取 {token, ips}。此端点不做 token 鉴权——短码本身就是一次性凭证（5 分钟 TTL）。
        const code = url.searchParams.get("code") ?? "";
        const { consumePairingCode } = await import("./pairing-codes.js");
        const entry = await consumePairingCode(code);
        if (!entry) {
          writeJson(response, 404, { error: "pairing code invalid or expired" });
          return;
        }
        writeJson(response, 200, { token: entry.token, ips: entry.ips, port: entry.port });
        return;
      }


      if (!this.authorized(request, url)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        const status = this.controller.getStatus();
        writeJson(response, 200, status satisfies HostStatus);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        const cwd = url.searchParams.get("cwd") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw === null ? undefined : Number(limitRaw);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const query = url.searchParams.get("query") ?? undefined;
        const sessionIds = url.searchParams.getAll("sessionIds").flatMap((value) => value.split(",")).filter(Boolean);
        const latestForCwds = url.searchParams.getAll("latestForCwds").flatMap((value) => value.split(",")).filter(Boolean);
        const listOptions = {
          ...(cwd ? { cwd } : {}),
          ...(limitRaw !== null ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          ...(query ? { query } : {}),
          ...(sessionIds.length ? { sessionIds } : {}),
          ...(latestForCwds.length ? { latestForCwds } : {}),
        };
        // Targeted/search requests need the shared service's complete index; cwd-only
        // requests can retain the runtime's narrower listing behavior.
        const loadCwd = sessionIds.length || latestForCwds.length || query ? undefined : cwd;
        const list = await this.hostSessionList.list(() => this.controller.listSessions(loadCwd), listOptions);
        writeJson(response, 200, list);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/maestro") {
        const state = await this.controller.readMaestroStateNow();
        writeJson(response, 200, state);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/maestro-settings") {
        const overview = await readSettingsOverview();
        writeJson(response, 200, overview);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/pair-ips") {
        // 扫码配对的候选 IP 列表（App 扫短 QR 后拉取；本机全部非内部 IPv4）
        const { networkInterfaces } = await import("node:os");
        const rank = (ip: string): number =>
          ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
        const ips: { ip: string; r: number }[] = [];
        for (const addrs of Object.values(networkInterfaces())) {
          for (const a of addrs ?? []) {
            if (a.family !== "IPv4" || a.internal) continue;
            if (a.address.startsWith("169.254.")) continue;
            ips.push({ ip: a.address, r: rank(a.address) });
          }
        }
        ips.sort((x, y) => x.r - y.r);
        writeJson(response, 200, { ips: ips.map((c) => c.ip) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/workspace-telemetry") {
        const telemetry = await this.controller.readTelemetry();
        writeJson(response, 200, telemetry);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/live-sessions") {
        const list = await this.controller.listLiveSessions();
        writeJson(response, 200, list satisfies LiveSessionList);
        return;
      }

      // 图片/文件只读预览：绝对路径 + 图片扩展名 + 大小限制
      if (request.method === "GET" && url.pathname === "/api/file") {
        const filePath = url.searchParams.get("path") ?? "";
        const result = await serveImageFile(filePath);
        if (!result) {
          writeJson(response, 400, { error: "Invalid or unsupported file path" });
          return;
        }
        const { data, mime } = result;
        response.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": data.length,
          "Cache-Control": "private, max-age=300",
        });
        response.end(data);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/extension-ui/pending") {
        writeJson(response, 200, { pending: 0 });
        return;
      }

      writeJson(response, 404, { error: `No route for ${request.method} ${url.pathname}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { error: message });
    }
  }

  private authorized(request: IncomingMessage, url: URL): boolean {
    const token = this.options.token;
    if (!token) return true;
    const header = request.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      return header.slice("Bearer ".length).trim() === token;
    }
    return url.searchParams.get("token") === token;
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    // P0-1：浏览器发起的 WS（带 Origin）必须来自白名单，防恶意网页 drive-by 连接；
    // 非浏览器客户端（RN fetch/ws）通常无 Origin，放行后仍由 token 鉴权把关。
    if (!this.isOriginAllowed(request.headers.origin, request.headers.host)) {
      console.error("[maestro-mobile] WS upgrade rejected: 403 origin=", request.headers.origin);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!this.authorized(request, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      console.error("[maestro-mobile] WS upgrade rejected: 401 (token mismatch) from", request.socket.remoteAddress);
      socket.destroy();
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      this.webSocketServer.emit("connection", ws, request);
    });
  }

  /** WS 握手 Origin 白名单：loopback 变体 + 绑定 host（非 0.0.0.0 时）+ 显式配置 */
  private isOriginAllowed(origin: string | undefined, requestHost = ""): boolean {
    if (!origin) return true; // 非浏览器客户端
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return true;
    }
    // 原生客户端（React Native OkHttp 等）会把 Origin 设为 WS URL 自身（= 本机地址）。
    // 这类请求 host 头与 origin 同源，放行；浏览器跨站 drive-by 的 origin 不会等于本机地址。
    const hostHeader = requestHost.toLowerCase();
    if (hostHeader && (hostHeader === hostname || hostHeader === `${hostname}:${parsed.port}`)) {
      return true;
    }
    const bound = this.boundHost.toLowerCase();
    if (bound !== "0.0.0.0" && bound !== "::" && hostname === bound) {
      return true;
    }
    const allowed = this.options.allowedOrigins ?? [];
    return allowed.some((o) => {
      try {
        return new URL(o).hostname.toLowerCase() === hostname;
      } catch {
        return false;
      }
    });
  }

  // ── WS 命令 ───────────────────────────────────────────────────────────────

  private async handleClientMessage(client: ClientSocket, data: RawData): Promise<void> {
    let command: ClientCommand;
    try {
      command = JSON.parse(data.toString()) as ClientCommand;
    } catch {
      this.sendFrame(client, { type: "error", code: "invalid_json", message: "Invalid JSON" }, "required", "error");
      return;
    }

    // P3-2：分发前真正走 shared 校验（激活 validation 模块，拦截缺 type 的任意载荷）
    try {
      command = validateClientCommand(command);
    } catch {
      this.sendFrame(client, { type: "error", code: "invalid_command", message: "Invalid ClientCommand: missing type" }, "required", "error");
      return;
    }

    try {
      switch (command.type) {
        case "list_live_sessions": {
          const list = await this.controller.listLiveSessions();
          this.sendAck(client, command, list);
          break;
        }
        case "load_more_history": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          const result = await runner.loadMoreHistory(command.count);
          this.sendAck(client, command, result);
          break;
        }
        case "search_history": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          // 服务端硬上限：客户端可传任意值（全扫 165MB 会话 + 无界结果集），不信任入参
          const maxResults = clampCommandInt(command.maxResults, 50, MAX_SEARCH_RESULTS);
          const previewLength = clampCommandInt(command.previewLength, 120, MAX_SEARCH_PREVIEW_LENGTH);
          const result = await runner.searchHistory(command.keyword, maxResults, previewLength);
          this.sendAck(client, command, result);
          break;
        }
        case "list_models": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          const models = typeof runner.listModels === "function" ? runner.listModels() : [];
          this.sendAck(client, command, models);
          break;
        }
        case "list_skills": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          // 优先走 SDK resourceLoader（与 TUI 一致），回退到文件扫描
          const loaded = typeof runner.listLoadedSkills === "function" ? runner.listLoadedSkills() : [];
          const skills = loaded.length > 0 ? loaded : await listSkills(runner.state.cwd);
          this.sendAck(client, command, skills);
          break;
        }
        case "get_maestro_settings": {
          const overview = await readSettingsOverview();
          this.sendAck(client, command, overview);
          break;
        }
        case "update_maestro_settings": {
          if (command.key !== "settings") {
            this.sendError(client, "unsupported_key", undefined, (command as { id?: string }).id ?? "");
            break;
          }
          const result = await updateSettingsJson(command.patch);
          this.sendAck(client, command, result);
          break;
        }
        case "set_model": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          if (typeof runner.setModel !== "function") { this.sendError(client, "unsupported_command", undefined, (command as { id?: string }).id ?? ""); break; }
          const result = await runner.setModel(command.modelId);
          this.sendAck(client, command, result);
          break;
        }
        case "set_thinking": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          if (typeof runner.setThinking !== "function") { this.sendError(client, "unsupported_command", undefined, (command as { id?: string }).id ?? ""); break; }
          const result = runner.setThinking(command.level);
          this.sendAck(client, command, result);
          break;
        }
        case "compact": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          if (typeof runner.compact !== "function") { this.sendError(client, "unsupported_command", undefined, (command as { id?: string }).id ?? ""); break; }
          const result = await runner.compact(command.customInstructions);
          this.sendAck(client, command, result);
          break;
        }
        case "rename_session": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          if (typeof runner.renameSession !== "function") { this.sendError(client, "unsupported_command", undefined, (command as { id?: string }).id ?? ""); break; }
          const result = runner.renameSession(command.name);
          this.sendAck(client, command, result);
          break;
        }
        case "list_host_sessions": {
          const list = await this.hostSessionList.list(
            () => this.controller.listSessions(command.cwd),
            command,
          );
          this.sendAck(client, command, list);
          break;
        }
        case "open_session": {
          const runner = await this.controller.openSession({
            cwd: command.cwd,
            mode: command.mode,
            sessionFile: command.sessionFile,
          });
          this.sendAck(client, command, { sessionId: runner.id });
          break;
        }
        case "close_session": {
          await this.controller.closeSession(command.sessionId);
          this.sendAck(client, command, { closed: true });
          break;
        }
        case "prompt": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          // P1-3：透传图片（此前被静默丢弃），非法元素显式报错而非静默丢失
          const images = command.images?.map((img) => toSdkImageContent(img)).filter((x) => x !== undefined);
          if (command.images && command.images.length > 0 && images?.length !== command.images.length) {
            this.sendError(client, "invalid_image", "images 元素必须是 base64 data 与 mime 字段齐全的图片", (command as { id?: string }).id ?? "");
            break;
          }
          await runner.prompt(command.message, undefined, images);
          this.sendAck(client, command, {});
          break;
        }
        case "steer": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          await runner.steer(command.message);
          this.sendAck(client, command, {});
          break;
        }
        case "steer_window": {
          // 监督会话跨窗口发送：已打开 → 直接 steer；未打开 → 接管（open_session continue）后 steer。
          // 接管语义：Host 打开的会话与原桌面 Pi 进程并行写同一 JSONL，移动端 UI 必须明示「接管并发送」。
          const existing = this.controller.getSession(command.endpointId);
          if (existing) {
            await existing.steer(command.message);
            this.sendAck(client, command, { ok: true, sessionId: command.endpointId, tookOver: false });
            break;
          }
          try {
            const runner = await this.controller.openSession({ cwd: command.cwd, mode: "continue", sessionFile: undefined });
            await runner.steer(command.message);
            this.sendAck(client, command, { ok: true, sessionId: runner.id, tookOver: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.sendAck(client, command, { ok: false, sessionId: command.endpointId, tookOver: false, error: message });
          }
          break;
        }
        case "follow_up": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          await runner.followUp(command.message);
          this.sendAck(client, command, {});
          break;
        }
        case "abort": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          await runner.abort();
          this.sendAck(client, command, {});
          break;
        }
        case "extension_ui_response": {
          const ok = this.controller.respondToExtensionUi(
            command.sessionId,
            command.requestId,
            command.response,
          );
          if (ok) {
            this.sendAck(client, command, {});
          } else {
            this.sendError(client, "request_not_found", (command as { id?: string }).id ?? "");
          }
          break;
        }
        case "get_maestro_state": {
          const state = await this.controller.readMaestroStateNow();
          this.sendAck(client, command, state);
          break;
        }
        case "get_monitor_state": {
          // 与推送路径共用同一投影，避免双投影漂移
          const telemetry = await this.controller.readTelemetry();
          this.sendAck(client, command, projectMonitorState(telemetry));
          break;
        }
        case "get_snapshot": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          const snapshot = runner.snapshot() satisfies SessionSnapshot;
          this.sendFrame(client, {
            type: "command_result",
            in_reply_to: (command as { id?: string }).id ?? "",
            ok: true,
            result: snapshot,
          }, "required", "command_result");
          break;
        }
        case "get_session_usage": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          const usage = typeof runner.getUsage === "function" ? await runner.getUsage() : { entries: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 };
          const context = typeof runner.getContextUsage === "function" ? runner.getContextUsage() ?? null : null;
          this.sendAck(client, command, { sessionId: command.sessionId, ...usage, context });
          break;
        }
        default:
          this.sendError(client, "unsupported_command", (command as { id?: string }).id ?? "");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendError(client, "command_failed", message);
    }
  }

  private sendAck(client: ClientSocket, command: ClientCommand, result: unknown): void {
    this.sendFrame(client, {
      type: "command_result",
      in_reply_to: (command as { id?: string }).id ?? "",
      ok: true,
      result,
    }, "required", "command_result");
  }

  private sendError(client: ClientSocket, code: string, message?: string, replyTo = ""): void {
    this.sendFrame(client, {
      type: "command_result",
      in_reply_to: replyTo,
      ok: false,
      error: { code, message: message ? sanitizeWsErrorMessage(message) : code },
    }, "required", "command_result");
  }
}

const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_PREVIEW_LENGTH = 400;

/**
 * 命令参数钳制（导出以供回归测试直接钉本函数，避免测试复制一份算式假通过）：
 * 非有限值（NaN/Infinity/null/字符串形态）落默认值，有限值夹到 [1, max]。
 */
export function clampCommandInt(raw: number | undefined, dflt: number, max: number): number {
  return Number.isFinite(raw) ? Math.min(Math.max(1, Math.floor(raw as number)), max) : dflt;
}

/**
 * WS/日志/响应用错误文本脱敏：限长 + 去换行 + 抹掉绝对路径与 token 痕迹。
 * 背景：command_failed 曾把底层 fs/SDK 的 Error.message（含绝对路径）原样回传网络；
 * 日志面同理（token 可能出现在 URL/argv 形态的错误文本里）。完整堆栈只进服务端日志的
 * 结构化字段，不经此函数回传客户端。
 */
function sanitizeWsErrorMessage(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/[ \t\r\n]+/g, " ")
    // 绝对路径（类 Unix）与 Windows 盘符路径 → 只保留文件名
    .replace(/(?:[A-Za-z]:)?[\\/][^\\/:*?"<>|]+(?:[\\/][^\\/:*?"<>|]+)*/g, (m) => m.split(/[\\/]/).filter(Boolean).pop() ?? "[path]")
    // 形态似密串的长 token（≥32 位连续 base64/hex 字符）
    .replace(/\b[A-Za-z0-9+/=\-_]{32,}\b/g, "[redacted]")
    .slice(0, 200);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function applyCorsHeaders(response: ServerResponse, origin?: string): void {
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
}

/**
 * 将 SessionManager 返回的完整 SessionInfo 裁剪为移动端友好的摘要。
 * 关键：不携带 allMessagesText 等大字段，避免移动端流量/内存浪费。
 */
async function toSessionSummaryList(records: unknown[]): Promise<HostSessionList> {
  const sessions: HostSessionSummary[] = [];
  for (const raw of records) {
    const r = raw as Record<string, unknown>;
    const cwd = String(r.cwd ?? "");
    const title = String(r.firstMessage ?? r.title ?? "");
    const id = String(r.id ?? "");
    const path = String(r.path ?? r.sessionFile ?? "");
    sessions.push({
      id,
      cwd,
      cwdName: cwd.split("/").filter(Boolean).pop() ?? cwd,
      path,
      title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
      name: typeof r.name === "string" && r.name ? r.name : undefined,
      model: await latestModelFromJsonl(path),
      messageCount: typeof r.messageCount === "number" ? r.messageCount : 0,
      // 规范化为 ISO 字符串：Hermes（iOS）解析不了 "Thu Sep 03 2026 ..." 这种本地化格式
      updatedAt: normalizeIso(String(r.modified ?? r.updatedAt ?? "")),
      ...(r.created ? { createdAt: normalizeIso(String(r.created)) } : {}),
    });
  }
  return { sessions, observedAt: new Date().toISOString() };
}

/** 从 jsonl 里找最近的 model_change，返回 provider/modelId 精简名 */
async function latestModelFromJsonl(path: string): Promise<string | undefined> {
  if (!path || !path.endsWith(".jsonl")) return undefined;
  try {
    // 只读尾部 256KB（model_change 通常在会话活跃期靠后出现），避免整文件扫描
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const readLen = Math.min(TRAIL_READ_BYTES, size);
      const buf = Buffer.alloc(readLen);
      await handle.read(buf, 0, readLen, size - readLen);
      const tail = buf.toString("utf8");
      const lines = tail.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes("model_change")) continue;
        try {
          const o = JSON.parse(line) as { provider?: string; modelId?: string };
          if (o.modelId) {
            const provider = o.provider ? `${o.provider}/` : "";
            return `${provider}${o.modelId}`;
          }
        } catch {
          // ignore malformed
        }
      }
      return undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

const TRAIL_READ_BYTES = 256 * 1024;

/** 尝试解析为 ISO；无法解析时保留原字符串（App 端需兜底） */
function normalizeIso(raw: string): string {
  if (!raw) return "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : raw;
}

/** 协议 images 元素 → Pi SDK ImageContent（type/data/mimeType）；非法返回 undefined */
function toSdkImageContent(img: { data: string; mime: string }): { type: "image"; data: string; mimeType: string } | undefined {
  if (typeof img?.data !== "string" || img.data.length === 0) return undefined;
  if (typeof img?.mime !== "string" || !img.mime.startsWith("image/")) return undefined;
  return { type: "image", data: img.data, mimeType: img.mime };
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** stat 包装（抛错由调用方捕获） */
function fstat(p: string): Promise<{ size: number }> {
  return stat(p) as unknown as Promise<{ size: number }>;
}

/** 安全读取本地图片：绝对路径 + 图片扩展名 + 大小限制 + realpath 防 symlink 绕过 */
async function serveImageFile(filePath: string): Promise<{ data: Buffer; mime: string } | undefined> {
  const trimmed = filePath.trim();
  if (!trimmed || !isAbsolute(trimmed)) return undefined;
  // 防止路径穿越：normalize 后必须仍是绝对路径且不含 ..
  const normalized = normalize(trimmed);
  if (!isAbsolute(normalized) || normalized.includes("..")) return undefined;

  const ext = normalized.slice(normalized.lastIndexOf(".")).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return undefined;

  try {
    // P3-3：先解析真实路径，防止指向任意位置的 symlink 绕过绝对路径约束
    const resolved = await realpath(normalized);
    if (!(await isUnderAllowedRoot(resolved))) return undefined;
    // 先 stat 校验大小再读取，避免超大文件先耗尽内存
    const stat = await fstat(resolved);
    if (stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return undefined;
    const data = await readFile(resolved);
    return { data, mime: IMAGE_MIME[ext] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}

/** 允许读取的根目录：用户目录、系统临时目录、进程工作目录（会话产物、图片预览所在）。取 realpath 以兼容 /tmp → /private/tmp */
async function isUnderAllowedRoot(resolved: string): Promise<boolean> {
  const roots = [homedir(), tmpdir(), process.cwd()];
  for (const root of roots) {
    try {
      const rp = await realpath(root);
      if (resolved === rp || resolved.startsWith(rp + "/")) return true;
    } catch {
      // root 不存在时跳过
    }
  }
  return false;
}
/** 扫描可用的 skill 名录（agent 全局 + 项目本地） */
async function listSkills(cwd: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const dirs: string[] = [];
  try { dirs.push(join(homedir(), ".pi", "agent", "skills")); } catch { /* skip */ }
  try { dirs.push(join(cwd, ".pi", "skills")); } catch { /* skip */ }
  const names = new Set<string>();
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".")) names.add(e.name);
      }
    } catch {
      // skip
    }
  }
  return [...names].sort();
}
