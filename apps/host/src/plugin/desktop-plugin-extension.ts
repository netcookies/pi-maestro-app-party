import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { DesktopPluginTarget } from "@maestro-mobile/shared";
import { DesktopPluginIpcClient } from "./desktop-plugin-ipc.js";
import { DesktopPiSessionAdapter } from "./desktop-pi-session-adapter.js";

const DEFAULT_SOCKET_PATH = join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-plugin.sock");
const DEFAULT_SECRET_PATH = join(homedir(), ".pi", "maestro-mobile-ipc-secret");

export interface DesktopPluginExtensionOptions {
  socketPath?: string;
  secretPath?: string;
  secret?: string;
  endpointId?: string;
  processGeneration?: string;
}

function messageContent(message: string, images?: unknown[]): string | Array<TextContent | ImageContent> {
  if (!images || images.length === 0) return message;
  const content: Array<TextContent | ImageContent> = [{ type: "text", text: message }];
  for (const image of images) {
    if (typeof image !== "object" || image === null) continue;
    const data = (image as { data?: unknown }).data;
    const mime = (image as { mime?: unknown }).mime;
    if (typeof data === "string" && typeof mime === "string") {
      content.push({ type: "image", data, mimeType: mime });
    }
  }
  return content;
}

async function resolveSecret(options: DesktopPluginExtensionOptions): Promise<string | undefined> {
  if (options.secret) return options.secret;
  const path = options.secretPath ?? DEFAULT_SECRET_PATH;
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function createDesktopPluginExtension(options: DesktopPluginExtensionOptions = {}) {
  return function desktopPluginExtension(pi: ExtensionAPI): void {
    let client: DesktopPluginIpcClient | undefined;
    let adapter: DesktopPiSessionAdapter | undefined;

    pi.on("session_start", (_event, ctx: ExtensionContext) => {
      const target: DesktopPluginTarget = {
        sessionId: ctx.sessionManager.getSessionId(),
        endpointId: options.endpointId ?? `desktop-${randomUUID()}`,
        normalizedCwd: normalize(ctx.cwd),
        processGeneration: options.processGeneration ?? randomUUID(),
      };
      const api = {
        prompt: async (message: string, images?: unknown[]) => {
          pi.sendUserMessage(messageContent(message, images));
        },
        steer: async (message: string) => {
          pi.sendUserMessage(message, { deliverAs: "steer" });
        },
        followUp: async (message: string) => {
          pi.sendUserMessage(message, { deliverAs: "followUp" });
        },
        abort: () => { ctx.abort(); },
        getAllTools: () => pi.getAllTools(),
      };
      adapter = new DesktopPiSessionAdapter(api, target);
      pi.on("tool_call", (event) => {
        const askRequest = adapter?.observeToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
        if (askRequest) void client?.sendAskRequest(askRequest).catch(() => undefined);
      });
      void (async () => {
        const secret = await resolveSecret(options);
        if (!secret || !adapter) return;
        client = new DesktopPluginIpcClient({
          socketPath: options.socketPath ?? DEFAULT_SOCKET_PATH,
          secret,
          target,
          capabilities: adapter.getCapabilities(),
          onRequest: (request) => adapter?.execute(request) ?? Promise.resolve({
            type: "desktop_plugin_result" as const,
            requestId: request.requestId,
            operation: request.operation.type,
            status: "failed" as const,
            error: { code: "plugin_unavailable" },
          }),
          onAskResponse: (response) => adapter?.answerAsk(response) ?? Promise.resolve(),
        });
        await client.connect().catch(() => undefined);
      })();
    });

    pi.on("session_shutdown", async () => {
      client?.close();
      client = undefined;
      await adapter?.dispose();
      adapter = undefined;
    });
  };
}

export default createDesktopPluginExtension();
