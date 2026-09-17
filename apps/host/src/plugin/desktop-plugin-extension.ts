import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { DesktopPluginEvent, DesktopPluginModel, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DesktopPluginIpcClient } from "./desktop-plugin-ipc.js";
import { DesktopPiSessionAdapter, deliveryFailure } from "./desktop-pi-session-adapter.js";

const DEFAULT_SOCKET_PATH = join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-plugin.sock");
const DEFAULT_SECRET_PATH = join(homedir(), ".pi", "maestro-mobile-ipc-secret");
const DESKTOP_PLUGIN_RECONNECT_DELAY_MS = 1_000;

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

function modelInfo(model: Model<any> | undefined): DesktopPluginModel | undefined {
  if (!model) return undefined;
  const provider = String(model.provider ?? "");
  const id = String(model.id ?? "");
  const name = String(model.name ?? model.id ?? "");
  if (!provider || !id || !name) return undefined;
  return {
    provider,
    id,
    name,
    reasoning: Boolean(model.reasoning),
    vision: Array.isArray(model.input) && model.input.includes("image"),
  };
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
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let connecting = false;
    let stopping = false;
    let latestModel: DesktopPluginModel | undefined;

    const scheduleReconnect = (): void => {
      if (stopping || reconnectTimer || client?.isConnected) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connectDesktopPlugin();
      }, DESKTOP_PLUGIN_RECONNECT_DELAY_MS);
    };

    const connectDesktopPlugin = async (): Promise<void> => {
      if (stopping || connecting || client?.isConnected || !adapter) return;
      connecting = true;
      const secret = await resolveSecret(options);
      if (!secret) {
        connecting = false;
        scheduleReconnect();
        return;
      }
      const candidate = new DesktopPluginIpcClient({
        socketPath: options.socketPath ?? DEFAULT_SOCKET_PATH,
        secret,
        target: adapter.target,
        capabilities: adapter.getCapabilities(),
        onRequest: (request) => adapter?.execute(request) ?? Promise.resolve({
          type: "desktop_plugin_result" as const,
          requestId: request.requestId,
          operation: request.operation.type,
          status: "failed" as const,
          error: { code: "plugin_unavailable" },
        }),
        onAskResponse: (response) => adapter?.answerAsk(response) ?? Promise.resolve(),
        onDisconnected: () => {
          if (client !== candidate) return;
          client = undefined;
          scheduleReconnect();
        },
      });
      client = candidate;
      try {
        await candidate.connect();
        if (latestModel) {
          await candidate.sendModelSelect({ type: "desktop_plugin_event", event: "model_select", model: latestModel }).catch(() => undefined);
        }
      } catch {
        if (client === candidate) client = undefined;
        candidate.close();
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    };

    pi.on("session_start", (_event, ctx: ExtensionContext) => {
      stopping = false;
      const target: DesktopPluginTarget = {
        sessionId: ctx.sessionManager.getSessionId(),
        endpointId: options.endpointId ?? `desktop-${randomUUID()}`,
        normalizedCwd: normalize(ctx.cwd),
        processGeneration: options.processGeneration ?? randomUUID(),
      };
      // `sendUserMessage` 返回 void 且失败被 SDK 吞进 emitError（调用方无法 catch），
      // 因此在此提前执行投递预检，用带 code 的抛错把它变成可观测结果。
      // 无条件预检（不判 isIdle）是安全的：能进入流式状态的会话必然已有可用模型与凭据，
      // 不会拒绝任何本可投递的消息；同时避开「校验时空闲、投递时已流式」的竞态
      // （SDK 在预检与入队之间存在 await）。
      // 不得用 `text.startsWith("/")` 拦截：`sendUserMessage` 以 expandPromptTemplates:false
      // 绕过扩展命令解析，以 "/" 开头的文本是合法消息。
      const assertDeliverable = (): void => {
        const model = ctx.model;
        if (!model) throw deliveryFailure("no_model_selected");
        if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw deliveryFailure("missing_model_auth");
      };
      const api = {
        prompt: async (message: string, images?: unknown[]) => {
          assertDeliverable();
          // `deliverAs` 仅在 AgentSession 处于 streaming 时被读取：空闲时走正常新轮次，
          // 流式中则入队 steer。与 host 侧「streaming 自动降级为 steer」语义一致且无竞态。
          pi.sendUserMessage(messageContent(message, images), { deliverAs: "steer" });
        },
        steer: async (message: string) => {
          assertDeliverable();
          pi.sendUserMessage(message, { deliverAs: "steer" });
        },
        followUp: async (message: string) => {
          assertDeliverable();
          pi.sendUserMessage(message, { deliverAs: "followUp" });
        },
        setModel: async (provider: string | undefined, modelId: string) => {
          const model = provider
            ? ctx.modelRegistry.find(provider, modelId)
            : ctx.modelRegistry.getAll().find((candidate) => String(candidate.id ?? "") === modelId);
          return model ? pi.setModel(model) : false;
        },
        abort: () => {
          ctx.abort();
        },
        getAllTools: () => pi.getAllTools(),
      };
      latestModel = modelInfo(ctx.model);
      adapter = new DesktopPiSessionAdapter(api, target);
      void connectDesktopPlugin();
    });

    pi.on("model_select", (event) => {
      latestModel = modelInfo(event.model);
      const modelEvent: DesktopPluginEvent | undefined = latestModel
        ? { type: "desktop_plugin_event", event: "model_select", model: latestModel }
        : undefined;
      if (modelEvent) void client?.sendModelSelect(modelEvent).catch(() => undefined);
    });

    pi.on("tool_call", (event) => {
      const askRequest = adapter?.observeToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
      if (askRequest) void client?.sendAskRequest(askRequest).catch(() => undefined);
    });

    pi.on("session_shutdown", async () => {
      stopping = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const activeClient = client;
      client = undefined;
      activeClient?.close();
      await adapter?.dispose();
      adapter = undefined;
    });
  };
}

export default createDesktopPluginExtension();
