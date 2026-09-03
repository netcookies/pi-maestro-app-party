import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { RawData } from "ws";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ClientCommand,
  HostEvent,
  HostStatus,
  SessionSnapshot,
} from "@maestro-mobile/shared";
import type { HostController } from "../host-controller.js";
import type { RuntimeFactory } from "../types.js";

export interface MobileHostServerOptions {
  token?: string;
  corsOrigin?: string;
}

interface ClientSocket {
  id: string;
  ws: WebSocket;
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
  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<ClientSocket>();
  private unsubscribeController: (() => void) | undefined;

  constructor(
    private readonly controller: HostController,
    private readonly options: MobileHostServerOptions = {},
  ) {
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });

    this.webSocketServer.on("connection", (ws) => {
      const client: ClientSocket = { id: crypto.randomUUID(), ws };
      this.clients.add(client);
      ws.send(JSON.stringify({ type: "host_status", status: this.controller.getStatus(), seq: 0 }));
      ws.on("message", (data) => {
        void this.handleClientMessage(client, data);
      });
      ws.on("close", () => {
        this.clients.delete(client);
      });
    });

    this.unsubscribeController = this.controller.onEvent((event) => {
      const payload = JSON.stringify(event);
      for (const client of this.clients) {
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.send(payload);
        }
      }
    });
  }

  listen(port: number, hostname = "0.0.0.0"): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, hostname, () => resolve());
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
    this.unsubscribeController?.();
    for (const client of this.clients) {
      client.ws.close();
    }
    this.clients.clear();
    this.webSocketServer.close();
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
        const sessions = await this.controller.listSessions(cwd);
        writeJson(response, 200, sessions);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/maestro") {
        const state = await this.controller.readMaestroStateNow();
        writeJson(response, 200, state);
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
    if (!this.authorized(request, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      this.webSocketServer.emit("connection", ws, request);
    });
  }

  // ── WS 命令 ───────────────────────────────────────────────────────────────

  private async handleClientMessage(client: ClientSocket, data: RawData): Promise<void> {
    let command: ClientCommand;
    try {
      command = JSON.parse(data.toString()) as ClientCommand;
    } catch {
      client.ws.send(JSON.stringify({ type: "error", code: "invalid_json", message: "Invalid JSON" }));
      return;
    }

    try {
      switch (command.type) {
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
          if (!runner) { this.sendError(client, "session_not_found"); break; }
          await runner.prompt(command.message);
          this.sendAck(client, command, {});
          break;
        }
        case "steer": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found"); break; }
          await runner.steer(command.message);
          this.sendAck(client, command, {});
          break;
        }
        case "follow_up": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found"); break; }
          await runner.followUp(command.message);
          this.sendAck(client, command, {});
          break;
        }
        case "abort": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found"); break; }
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
            this.sendError(client, "request_not_found");
          }
          break;
        }
        case "get_snapshot": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found"); break; }
          const snapshot = runner.snapshot() satisfies SessionSnapshot;
          client.ws.send(JSON.stringify({ type: "snapshot", snapshot }));
          break;
        }
        default:
          this.sendError(client, "unsupported_command");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendError(client, "command_failed", message);
    }
  }

  private sendAck(client: ClientSocket, command: ClientCommand, result: unknown): void {
    client.ws.send(JSON.stringify({
      type: "command_result",
      in_reply_to: (command as { id?: string }).id ?? "",
      ok: true,
      result,
    }));
  }

  private sendError(client: ClientSocket, code: string, message?: string): void {
    client.ws.send(JSON.stringify({
      type: "command_result",
      in_reply_to: "",
      ok: false,
      error: { code, message: message ?? code },
    }));
  }
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