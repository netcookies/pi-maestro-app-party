import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { DesktopPluginEvent, DesktopPluginModel, DesktopPluginRuntimeStatus, DesktopPluginSessionSummary, DesktopPluginTarget, DesktopAskRequest, JsonValue } from "@maestro-mobile/shared";
import { DesktopPluginIpcClient } from "./desktop-plugin-ipc.js";
import {
  beginDesktopPluginRuntimeRecord,
  clearDesktopPluginRuntimeRecord,
  updateDesktopPluginRuntimeRecord,
} from "./desktop-plugin-runtime-state.js";
import { DesktopPiSessionAdapter, deliveryFailure } from "./desktop-pi-session-adapter.js";
import {
  registerFlowAskTransport,
  type FlowAskAnswer,
  type FlowAskTransport,
  type FlowAskTransportResult,
} from "./flow-ask-transport.js";

const DEFAULT_SOCKET_PATH = join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-plugin.sock");
const DEFAULT_SECRET_PATH = join(homedir(), ".pi", "maestro-mobile-ipc-secret");
const DESKTOP_PLUGIN_RECONNECT_DELAY_MS = 1_000;

type PiThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

function isPiThinkingLevel(level: string): level is PiThinkingLevel {
  return level === "off" || level === "minimal" || level === "low" || level === "medium"
    || level === "high" || level === "xhigh" || level === "max";
}

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

function askCorrelationKey(requestId: string, toolCallId: string): string {
  return JSON.stringify([requestId, toolCallId]);
}

function desktopAskRequestFromFlow(request: Parameters<FlowAskTransport["open"]>[0]): DesktopAskRequest | undefined {
  let questions: JsonValue[];
  try {
    questions = JSON.parse(JSON.stringify(request.questions)) as JsonValue[];
  } catch {
    return undefined;
  }
  if (!Array.isArray(questions)) return undefined;
  return {
    type: "desktop_ask_request",
    requestId: `question:${request.toolCallId}`,
    toolCallId: request.toolCallId,
    questions,
    deadlineAt: Date.now() + 120_000,
  };
}

function flowResultFromDesktopResponse(response: unknown): FlowAskTransportResult {
  if (typeof response !== "object" || response === null) return { status: "cancelled" };
  const value = response as { cancelled?: unknown; value?: unknown };
  if (value.cancelled === true || typeof value.value !== "string") return { status: "cancelled" };
  try {
    const parsed = JSON.parse(value.value) as { answers?: unknown };
    return Array.isArray(parsed?.answers)
      ? { status: "answered", answers: parsed.answers as FlowAskAnswer[] }
      : { status: "cancelled" };
  } catch {
    return { status: "cancelled" };
  }
}

export function createDesktopPluginExtension(options: DesktopPluginExtensionOptions = {}) {
  return function desktopPluginExtension(pi: ExtensionAPI): void {
    let client: DesktopPluginIpcClient | undefined;
    let adapter: DesktopPiSessionAdapter | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    let sessionGeneration = 0;
    let connectionAttempt: {
      generation: number;
      adapter: DesktopPiSessionAdapter;
      promise: Promise<void>;
    } | undefined;
    let latestModel: DesktopPluginModel | undefined;
    let latestThinkingLevel: string | undefined;
    let sessionFile: string | undefined;
    let latestRuntimeStatus: DesktopPluginRuntimeStatus = "idle";
    let activeSince: string | undefined;
    let lastActivityAt: string | undefined;
    let messageCount = 0;
    let latestUsage: DesktopPluginSessionSummary["usage"];
    let latestContext: DesktopPluginSessionSummary["context"];
    let runtimeGenerationToken: string | undefined;
    interface PendingAsk {
      request: DesktopAskRequest;
      generation: number;
      adapter: DesktopPiSessionAdapter;
      resolve(result: FlowAskTransportResult): void;
      removeAbortListener?: () => void;
      sentGeneration?: number;
    }
    const pendingAskRequests = new Map<string, PendingAsk>();
    const retiredAskKeys = new Set<string>();
    let unregisterFlowAskTransport: (() => void) | undefined;
    const updateRuntime = (patch: Parameters<typeof updateDesktopPluginRuntimeRecord>[1]): void => {
      if (runtimeGenerationToken) updateDesktopPluginRuntimeRecord(runtimeGenerationToken, patch);
    };

    const countStoredMessages = (ctx: ExtensionContext): number => {
      const getEntries = (ctx.sessionManager as unknown as { getEntries?: () => unknown[] }).getEntries;
      return typeof getEntries === "function"
        ? getEntries.call(ctx.sessionManager).filter((entry) => Boolean(entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message")).length
        : messageCount;
    };
    const readContextUsage = (ctx: ExtensionContext): DesktopPluginSessionSummary["context"] => {
      const getContextUsage = (ctx as unknown as { getContextUsage?: () => DesktopPluginSessionSummary["context"] }).getContextUsage;
      return typeof getContextUsage === "function" ? getContextUsage.call(ctx) : undefined;
    };

    const isCurrentSession = (generation: number, sessionAdapter: DesktopPiSessionAdapter): boolean => (
      !stopping && sessionGeneration === generation && adapter === sessionAdapter
    );

    const rememberRetiredAsk = (key: string): void => {
      retiredAskKeys.add(key);
      while (retiredAskKeys.size > 128) retiredAskKeys.delete(retiredAskKeys.values().next().value!);
    };

    const settlePendingAsk = (key: string, result: FlowAskTransportResult): void => {
      const pending = pendingAskRequests.get(key);
      if (!pending) {
        rememberRetiredAsk(key);
        return;
      }
      pendingAskRequests.delete(key);
      pending.removeAbortListener?.();
      rememberRetiredAsk(key);
      pending.resolve(result);
    };

    const cancelPendingAsk = (key: string): void => {
      const pending = pendingAskRequests.get(key);
      if (!pending) {
        rememberRetiredAsk(key);
        return;
      }
      if (pending.sentGeneration !== undefined && client && isCurrentSession(pending.generation, pending.adapter)) {
        void client.sendAskCancellation(pending.request).catch((error: unknown) => {
          console.error(`[maestro-mobile] Ask cancellation failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      settlePendingAsk(key, { status: "cancelled" });
    };

    const flowAskTransport: FlowAskTransport = {
      open(request) {
        const sessionAdapter = adapter;
        const generation = sessionGeneration;
        if (stopping || !sessionAdapter || !isCurrentSession(generation, sessionAdapter)) return undefined;
        if (!sessionAdapter.getCapabilities().includes("ask-user-question")) return undefined;
        const desktopRequest = desktopAskRequestFromFlow(request);
        if (!desktopRequest) return undefined;
        const key = askCorrelationKey(desktopRequest.requestId, desktopRequest.toolCallId);
        if (pendingAskRequests.has(key)) return undefined;

        let resolvePromise!: (result: FlowAskTransportResult) => void;
        const promise = new Promise<FlowAskTransportResult>((resolve) => {
          resolvePromise = resolve;
        });
        const pending: PendingAsk = {
          request: desktopRequest,
          generation,
          adapter: sessionAdapter,
          resolve: resolvePromise,
        };
        const onAbort = () => cancelPendingAsk(key);
        request.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => request.signal.removeEventListener("abort", onAbort);
        pendingAskRequests.set(key, pending);
        if (request.signal.aborted) onAbort();

        void (async () => {
          try {
            const attempt = connectionAttempt?.promise;
            if (attempt) await attempt;
            if (pendingAskRequests.get(key) !== pending) return;
            if (!client || !isCurrentSession(generation, sessionAdapter)) {
              settlePendingAsk(key, { status: "cancelled" });
              return;
            }
            if (pending.sentGeneration === generation) return;
            pending.sentGeneration = generation;
            await client.sendAskRequest(desktopRequest);
          } catch {
            settlePendingAsk(key, { status: "cancelled" });
          }
        })();

        return {
          promise,
          cancel: () => cancelPendingAsk(key),
        };
      },
    };

    const scheduleReconnect = (generation = sessionGeneration): void => {
      if (stopping || generation !== sessionGeneration || reconnectTimer || client?.isConnected) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (stopping || generation !== sessionGeneration) return;
        void connectDesktopPlugin();
      }, DESKTOP_PLUGIN_RECONNECT_DELAY_MS);
    };

    const connectDesktopPlugin = (): Promise<void> => {
      const sessionAdapter = adapter;
      const generation = sessionGeneration;
      if (stopping || client?.isConnected || !sessionAdapter) return Promise.resolve();
      if (connectionAttempt?.generation === generation) return connectionAttempt.promise;

      const attempt = {
        generation,
        adapter: sessionAdapter,
        promise: Promise.resolve(),
      };
      const abandonCandidate = (candidate: DesktopPluginIpcClient): void => {
        if (client === candidate) client = undefined;
        candidate.close();
      };
      attempt.promise = (async () => {
        let candidate: DesktopPluginIpcClient | undefined;
        try {
          const secret = await resolveSecret(options);
          if (!isCurrentSession(generation, sessionAdapter)) return;
          if (!secret) {
            scheduleReconnect(generation);
            return;
          }

          candidate = new DesktopPluginIpcClient({
            socketPath: options.socketPath ?? DEFAULT_SOCKET_PATH,
            secret,
            target: sessionAdapter.target,
            ...(sessionFile ? { sessionFile } : {}),
            capabilities: sessionAdapter.getCapabilities(),
            onRequest: (request) => sessionAdapter.execute(request),
            onAskResponse: async (response) => {
              const key = askCorrelationKey(response.requestId, response.toolCallId);
              if (pendingAskRequests.has(key)) {
                settlePendingAsk(key, flowResultFromDesktopResponse(response.response));
                return;
              }
              if (retiredAskKeys.delete(key)) return;
              // 兼容仍走旧 Desktop Ask 文件桥的非 Flow 请求。
              await sessionAdapter.answerAsk(response);
            },
            onDisconnected: () => {
              if (client !== candidate) return;
              client = undefined;
              for (const key of [...pendingAskRequests.keys()]) settlePendingAsk(key, { status: "cancelled" });
              if (!isCurrentSession(generation, sessionAdapter)) return;
              updateRuntime({ pluginBroker: "disconnected", error: "desktop plugin disconnected" });
              scheduleReconnect(generation);
            },
          });
          client = candidate;
          await candidate.connect();
          if (!isCurrentSession(generation, sessionAdapter)) {
            abandonCandidate(candidate);
            return;
          }

          updateRuntime({ pluginBroker: "connected", error: null });
          await candidate.sendSessionSummary({
            type: "desktop_plugin_event",
            event: "session_summary",
            summary: currentSummary(),
          }).catch(() => undefined);
          if (!isCurrentSession(generation, sessionAdapter)) {
            abandonCandidate(candidate);
            return;
          }
          if (latestModel) {
            await candidate.sendModelSelect({ type: "desktop_plugin_event", event: "model_select", model: latestModel }).catch(() => undefined);
          }
          if (!isCurrentSession(generation, sessionAdapter)) {
            abandonCandidate(candidate);
            return;
          }
          if (latestThinkingLevel) {
            await candidate.sendThinkingLevelSelect({
              type: "desktop_plugin_event", event: "thinking_level_select", level: latestThinkingLevel,
            }).catch(() => undefined);
          }
          if (!isCurrentSession(generation, sessionAdapter)) {
            abandonCandidate(candidate);
            return;
          }
          for (const [key, pending] of pendingAskRequests) {
            if (!isCurrentSession(generation, sessionAdapter)) {
              abandonCandidate(candidate);
              return;
            }
            if (pending.request.deadlineAt <= Date.now()) {
              settlePendingAsk(key, { status: "cancelled" });
              continue;
            }
            if (pending.sentGeneration === generation) continue;
            pending.sentGeneration = generation;
            await candidate.sendAskRequest(pending.request).catch(() => undefined);
          }
        } catch (error) {
          if (candidate) abandonCandidate(candidate);
          if (isCurrentSession(generation, sessionAdapter)) {
            updateRuntime({ pluginBroker: "disconnected", error });
            scheduleReconnect(generation);
          }
        }
      })().finally(() => {
        if (connectionAttempt === attempt) connectionAttempt = undefined;
      });
      connectionAttempt = attempt;
      return attempt.promise;
    };

    pi.on("session_start", (_event, ctx: ExtensionContext) => {
      sessionGeneration += 1;
      stopping = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const staleClient = client;
      client = undefined;
      staleClient?.close();
      for (const key of [...pendingAskRequests.keys()]) settlePendingAsk(key, { status: "cancelled" });
      retiredAskKeys.clear();
      unregisterFlowAskTransport?.();
      unregisterFlowAskTransport = registerFlowAskTransport(flowAskTransport);
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
        setThinking: (level: string) => {
          if (!isPiThinkingLevel(level)) throw new Error("invalid_thinking_level");
          pi.setThinkingLevel(level);
        },
        abort: () => {
          ctx.abort();
        },
        listModels: () => {
          const registry = ctx.modelRegistry;
          const all = registry.getAll();
          const available = typeof registry.getAvailable === "function" ? registry.getAvailable() : all;
          console.error(`[maestro-mobile] list_models all=${all.length} available=${available.length} hasCurrent=${Boolean(ctx.model)}`);
          // getAvailable() 可能因异步 auth snapshot 暂时为空；当前已绑定模型仍是安全的单项候选。
          const models = available.length > 0 ? available : (ctx.model ? [ctx.model] : []);
          return models.flatMap((candidate) => {
            const model = modelInfo(candidate);
            return model ? [model] : [];
          });
        },
        listSkills: () => {
          const commands = pi.getCommands();
          console.error(`[maestro-mobile] list_skills commands=${commands.length} skills=${commands.filter((command) => command.source === "skill").length}`);
          return commands.flatMap((command) => {
            if (command.source !== "skill" || typeof command.name !== "string" || !command.name.startsWith("skill:")) return [];
            return [{
              name: command.name.slice("skill:".length),
              ...(typeof command.description === "string" ? { description: command.description } : {}),
            }];
          });
        },
        getAllTools: () => pi.getAllTools(),
      };
      latestModel = modelInfo(ctx.model);
      latestThinkingLevel = pi.getThinkingLevel();
      sessionFile = ctx.sessionManager.getSessionFile();
      latestRuntimeStatus = ctx.isIdle() ? "idle" : "running";
      activeSince = undefined;
      latestUsage = undefined;
      if (latestRuntimeStatus === "running") activeSince = new Date().toISOString();
      lastActivityAt = new Date().toISOString();
      messageCount = countStoredMessages(ctx);
      latestContext = readContextUsage(ctx);
      runtimeGenerationToken = target.processGeneration;
      beginDesktopPluginRuntimeRecord({
        target,
        localStatus: latestRuntimeStatus,
        pluginBroker: "disconnected",
        transitionAt: new Date().toISOString(),
        generationToken: runtimeGenerationToken,
      });
      adapter = new DesktopPiSessionAdapter(api, target);
      void connectDesktopPlugin();
    });

    pi.on("model_select", (event) => {
      latestModel = modelInfo(event.model);
      const modelEvent: Extract<DesktopPluginEvent, { event: "model_select" }> | undefined = latestModel
        ? { type: "desktop_plugin_event", event: "model_select", model: latestModel }
        : undefined;
      if (modelEvent) void client?.sendModelSelect(modelEvent).catch(() => undefined);
    });

    pi.on("thinking_level_select", (event) => {
      latestThinkingLevel = event.level;
      void client?.sendThinkingLevelSelect({
        type: "desktop_plugin_event",
        event: "thinking_level_select",
        level: event.level,
      }).catch(() => undefined);
    });

    const currentSummary = (): DesktopPluginSessionSummary => ({
      runtimeStatus: latestRuntimeStatus,
      activeSince: activeSince ?? null,
      ...(lastActivityAt ? { lastActivityAt } : {}),
      messageCount,
      ...(latestUsage ? { usage: latestUsage } : {}),
      ...(latestContext !== undefined ? { context: latestContext } : {}),
    });

    const publishSummary = (): void => {
      const summary = currentSummary();
      updateRuntime({ localStatus: latestRuntimeStatus, summary });
      void client?.sendSessionSummary({
        type: "desktop_plugin_event",
        event: "session_summary",
        summary,
      }).catch(() => undefined);
    };

    const publishRuntimeStatus = (runtimeStatus: DesktopPluginRuntimeStatus): void => {
      latestRuntimeStatus = runtimeStatus;
      const now = new Date().toISOString();
      lastActivityAt = now;
      if (runtimeStatus === "running") activeSince = activeSince ?? now;
      else activeSince = undefined;
      publishSummary();
    };

    pi.on("agent_start", () => publishRuntimeStatus("running"));
    pi.on("message_end", (event, ctx) => {
      const role = (event as { message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } } }).message?.role;
      messageCount += 1;
      lastActivityAt = new Date().toISOString();
      if (role === "assistant") {
        const usage = (event as { message?: { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } } }).message?.usage;
        if (usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost?.total].every((value) => typeof value === "number")) {
          latestUsage = { input: usage.input!, output: usage.output!, cacheRead: usage.cacheRead!, cacheWrite: usage.cacheWrite!, totalTokens: usage.totalTokens!, cost: usage.cost!.total! };
        }
      }
      latestContext = readContextUsage(ctx);
      publishSummary();
    });
    pi.on("session_compact", (_event, ctx) => {
      messageCount = countStoredMessages(ctx);
      latestContext = readContextUsage(ctx);
      lastActivityAt = new Date().toISOString();
      publishSummary();
    });
    pi.on("agent_end", (_event, ctx) => {
      latestContext = readContextUsage(ctx);
      publishRuntimeStatus("idle");
    });

    pi.on("session_shutdown", async () => {
      const shutdownGeneration = sessionGeneration;
      const shutdownAdapter = adapter;
      const shutdownAttempt = connectionAttempt?.generation === shutdownGeneration
        ? connectionAttempt.promise
        : undefined;
      stopping = true;
      sessionGeneration += 1;
      adapter = undefined;
      for (const key of [...pendingAskRequests.keys()]) settlePendingAsk(key, { status: "cancelled" });
      unregisterFlowAskTransport?.();
      unregisterFlowAskTransport = undefined;
      retiredAskKeys.clear();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const activeClient = client;
      client = undefined;
      activeClient?.close();
      const generationToken = runtimeGenerationToken;
      runtimeGenerationToken = undefined;
      if (generationToken) clearDesktopPluginRuntimeRecord(generationToken);
      await shutdownAttempt;
      await shutdownAdapter?.dispose();
    });
  };
}

export default createDesktopPluginExtension();
