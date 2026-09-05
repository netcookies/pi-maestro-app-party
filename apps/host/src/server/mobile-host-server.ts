import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { RawData } from "ws";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { readFile, open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type {
  ClientCommand,
  HostEvent,
  HostSessionList,
  HostSessionSummary,
  HostStatus,
  SessionSnapshot,
} from "@maestro-mobile/shared";
import type { HostController } from "../host-controller.js";
import type { RuntimeFactory } from "../types.js";
import type { LiveSessionList } from "../live-sessions.js";
import { readSettingsOverview, updateSettingsJson } from "../maestro-settings.js";
import { WorkspaceTelemetryReader } from "../workspace-telemetry.js";

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
        const list = await toSessionSummaryList(sessions);
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
          const result = await runner.searchHistory(command.keyword, command.maxResults, command.previewLength);
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
          const sessions = await this.controller.listSessions(command.cwd);
          const list = await toSessionSummaryList(sessions);
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
          await runner.prompt(command.message);
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
          const telemetry = await this.controller.readTelemetry();
          this.sendAck(client, command, telemetry);
          break;
        }
        case "get_snapshot": {
          const runner = this.controller.getSession(command.sessionId);
          if (!runner) { this.sendError(client, "session_not_found", (command as { id?: string }).id ?? ""); break; }
          const snapshot = runner.snapshot() satisfies SessionSnapshot;
          client.ws.send(JSON.stringify({
            type: "command_result",
            in_reply_to: (command as { id?: string }).id ?? "",
            ok: true,
            result: snapshot,
          }));
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
    client.ws.send(JSON.stringify({
      type: "command_result",
      in_reply_to: (command as { id?: string }).id ?? "",
      ok: true,
      result,
    }));
  }

  private sendError(client: ClientSocket, code: string, message?: string, replyTo = ""): void {
    client.ws.send(JSON.stringify({
      type: "command_result",
      in_reply_to: replyTo,
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

/** 安全读取本地图片：绝对路径 + 图片扩展名 + 大小限制，返回二进制与 MIME */
async function serveImageFile(filePath: string): Promise<{ data: Buffer; mime: string } | undefined> {
  const trimmed = filePath.trim();
  if (!trimmed || !isAbsolute(trimmed)) return undefined;
  // 防止路径穿越：normalize 后必须仍是绝对路径且不含 ..
  const normalized = normalize(trimmed);
  if (!isAbsolute(normalized) || normalized.includes("..")) return undefined;

  const ext = normalized.slice(normalized.lastIndexOf(".")).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return undefined;

  try {
    const data = await readFile(normalized);
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return undefined;
    return { data, mime: IMAGE_MIME[ext] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
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
