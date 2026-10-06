import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { BackgroundJobSummary, DesktopPluginEvent, DesktopPluginExecutionSummary, DesktopPluginModel, DesktopPluginRuntimeStatus, DesktopPluginSessionSummary, DesktopPluginTarget, DesktopAskRequest, DesktopPlanResponse, JsonValue, MonitorTodoSummary, TeammateAgentState } from "@maestro-mobile/shared";
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
import {
  registerFlowPlanTransport,
  createDesktopPlanTransport,
  type DesktopPlanTransport,
} from "./flow-plan-transport.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SessionUsageProjection = NonNullable<DesktopPluginSessionSummary["usage"]>;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function usageProjection(value: unknown): SessionUsageProjection | undefined {
  if (!isRecord(value)) return undefined;
  const cost = isRecord(value.cost) ? value.cost.total : value.cost;
  const input = finiteNumber(value.input) ? value.input : 0;
  const output = finiteNumber(value.output) ? value.output : 0;
  const cacheRead = finiteNumber(value.cacheRead) ? value.cacheRead : 0;
  const cacheWrite = finiteNumber(value.cacheWrite) ? value.cacheWrite : 0;
  const totalTokens = finiteNumber(value.totalTokens) ? value.totalTokens : input + output + cacheRead + cacheWrite;
  if (totalTokens <= 0 && input + output + cacheRead + cacheWrite <= 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: finiteNumber(cost) ? cost : 0,
  };
}

function addUsage(left: SessionUsageProjection | undefined, right: SessionUsageProjection): SessionUsageProjection {
  return {
    input: (left?.input ?? 0) + right.input,
    output: (left?.output ?? 0) + right.output,
    cacheRead: (left?.cacheRead ?? 0) + right.cacheRead,
    cacheWrite: (left?.cacheWrite ?? 0) + right.cacheWrite,
    totalTokens: (left?.totalTokens ?? 0) + right.totalTokens,
    cost: (left?.cost ?? 0) + right.cost,
  };
}

function sessionEntriesOf(ctx: unknown): readonly unknown[] {
  if (!isRecord(ctx) || !isRecord(ctx.sessionManager)) return [];
  const getEntries = ctx.sessionManager.getEntries;
  if (typeof getEntries !== "function") return [];
  const entries = getEntries.call(ctx.sessionManager);
  return Array.isArray(entries) ? entries : [];
}

function usageFromSessionEntries(entries: readonly unknown[]): SessionUsageProjection | undefined {
  let total: SessionUsageProjection | undefined;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : undefined;
    let rawUsage: unknown;
    if (entry.type === "message" && isRecord(entry.message)
      && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
      rawUsage = entry.message.usage;
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      rawUsage = entry.usage;
    }
    const usage = usageProjection(rawUsage);
    if (!usage) continue;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    total = addUsage(total, usage);
  }
  return total;
}

function boundedText(value: unknown, maxLength = 512): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function todoSnapshotFromSessionEntries(entries: readonly unknown[]): MonitorTodoSummary[] | undefined {
  let entry: Record<string, unknown> | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (isRecord(candidate) && candidate.type === "custom" && candidate.customType === "todo-state") {
      entry = candidate;
      break;
    }
  }
  if (!entry) return [];
  const data = entry.data;
  if (!isRecord(data) || !isRecord(data.tasks)) return undefined;
  const todos: MonitorTodoSummary[] = [];
  const ids = new Set<string>();
  for (const [entryId, value] of Object.entries(data.tasks)) {
    if (!isRecord(value) || value.status === "deleted") continue;
    const id = boundedText(value.id) ?? boundedText(entryId);
    const subject = boundedText(value.subject);
    const status = boundedText(value.status, 64);
    const updatedAt = value.updatedAt;
    const assignee = isRecord(value.assignee) ? boundedText(value.assignee.label) : undefined;
    if (!id || !subject || !status || typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || ids.has(id)) return undefined;
    if (isRecord(value.assignee) && value.assignee.label !== undefined && !assignee) return undefined;
    ids.add(id);
    todos.push({ id, subject, status, updatedAt, ...(assignee ? { assigneeLabel: assignee } : {}) });
    if (todos.length >= 32) break;
  }
  return todos;
}

function flowTodoSnapshot(entries?: readonly unknown[]): MonitorTodoSummary[] | undefined {
  if (entries) {
    const sessionSnapshot = todoSnapshotFromSessionEntries(entries);
    if (sessionSnapshot === undefined || sessionSnapshot.length > 0) return sessionSnapshot;
  }
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-maestro.workspace-projection-providers.v1")];
  if (!(registry instanceof Map)) return entries ? [] : undefined;
  const provider = registry.get("todo");
  if (!isRecord(provider) || typeof provider.snapshot !== "function") return entries ? [] : undefined;
  try {
    const items = provider.snapshot();
    if (!Array.isArray(items)) return undefined;
    const todos: MonitorTodoSummary[] = [];
    const ids = new Set<string>();
    for (const item of items) {
      if (!isRecord(item) || item.kind !== "todo") continue;
      const data = item.data;
      if (!isRecord(data)) return undefined;
      const id = boundedText(data.id);
      const subject = boundedText(data.subject);
      const status = boundedText(data.status, 64);
      if (!id || !subject || !status || typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt) || ids.has(id)) return undefined;
      const assigneeLabel = data.assigneeLabel === undefined ? undefined : boundedText(data.assigneeLabel);
      if (data.assigneeLabel !== undefined && !assigneeLabel) return undefined;
      ids.add(id);
      todos.push({ id, subject, status, updatedAt: data.updatedAt, ...(assigneeLabel ? { assigneeLabel } : {}) });
      if (todos.length >= 32) break;
    }
    return todos;
  } catch {
    return undefined;
  }
  return entries ? [] : undefined;
}

function timestampIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function backgroundSnapshot(payload: unknown): BackgroundJobSummary[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) return undefined;
  const jobs: BackgroundJobSummary[] = [];
  for (const value of payload.jobs.slice(0, 64)) {
    if (!isRecord(value) || !boundedText(value.id)) return undefined;
    const status = value.status === "running" || value.status === "stopping" ? "running"
      : value.status === "completed" ? "completed"
        : value.status === "failed" ? "failed"
          : value.status === "killed" ? "cancelled" : undefined;
    const startedAt = timestampIso(value.startedAt);
    const finishedAt = value.finishedAt === undefined ? undefined : timestampIso(value.finishedAt);
    if (!status || !startedAt || (value.finishedAt !== undefined && !finishedAt)) return undefined;
    const label = typeof value.command === "string" ? value.command.slice(0, 512) : undefined;
    jobs.push({
      id: boundedText(value.id)!,
      status,
      ...(label ? { label } : {}),
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
    });
  }
  return jobs;
}

function currentTeammateProjection(sessionId: string): { workspaceId: string; sessionId: string; sourceId: string; generation: number } | undefined {
  const state = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-maestro-teammate.root-registry")];
  if (!isRecord(state) || state.currentSessionId !== sessionId) return undefined;
  const workspaceId = boundedText(state.currentWorkspaceId);
  const sourceId = boundedText(state.currentSourceId);
  const generation = state.sessionGeneration;
  return workspaceId && sourceId && Number.isSafeInteger(generation) && (generation as number) > 0
    ? { workspaceId, sessionId, sourceId, generation: generation as number }
    : undefined;
}

function sameTargetIdentity(left: DesktopPluginTarget, right: DesktopPluginTarget): boolean {
  return left.sessionId === right.sessionId && left.endpointId === right.endpointId
    && left.normalizedCwd === right.normalizedCwd && left.processGeneration === right.processGeneration;
}

// Shared Pi process bridge lets Teammate capture the target regardless of extension listener order.
function publishDesktopTargetIdentity(target: DesktopPluginTarget, sessionGeneration: number): boolean {
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-maestro-mobile.desktop-target-identity")] = { ...target };
  const state = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-maestro-teammate.root-registry")];
  if (!isRecord(state) || typeof state.publishDesktopTargetIdentity !== "function") return false;
  return state.publishDesktopTargetIdentity(target, sessionGeneration) === true;
}

function clearDesktopTargetIdentity(target: DesktopPluginTarget): boolean {
  const globals = globalThis as Record<symbol, unknown>;
  const sharedTarget = globals[Symbol.for("pi-maestro-mobile.desktop-target-identity")];
  if (isRecord(sharedTarget) && sameTargetIdentity(sharedTarget as unknown as DesktopPluginTarget, target)) {
    delete globals[Symbol.for("pi-maestro-mobile.desktop-target-identity")];
  }
  const state = globals[Symbol.for("pi-maestro-teammate.root-registry")];
  if (!isRecord(state) || typeof state.clearDesktopTargetIdentity !== "function") return false;
  return state.clearDesktopTargetIdentity(target) === true;
}

function sameProjection(value: unknown, expected: { workspaceId: string; sessionId: string; sourceId: string; generation: number }): boolean {
  return isRecord(value)
    && value.workspaceId === expected.workspaceId
    && value.sessionId === expected.sessionId
    && value.sourceId === expected.sourceId
    && value.generation === expected.generation;
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
    let activeTarget: DesktopPluginTarget | undefined;
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
    let executionSessionId: string | undefined;
    let executionTargetGeneration: string | undefined;
    let executionTeammateProjection: { workspaceId: string; sessionId: string; sourceId: string; generation: number } | undefined;
    let executionAgents = new Map<string, TeammateAgentState>();
    let executionJobs: BackgroundJobSummary[] = [];
    let executionRevision = 0;
    let executionFingerprint = "";
    let executionTodoEntries: (() => unknown[]) | undefined;
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
    let planTransport: DesktopPlanTransport | undefined;
    let unregisterFlowPlanTransport: (() => void) | undefined;

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
              scheduleReconnect(generation);
              return;
            }
            if (pending.sentGeneration === generation) return;
            pending.sentGeneration = generation;
            try {
              await client.sendAskRequest(desktopRequest);
            } catch {
              pending.sentGeneration = undefined;
              scheduleReconnect(generation);
            }
          } catch {
            scheduleReconnect(generation);
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
              if (retiredAskKeys.has(key)) return;
              if (pendingAskRequests.has(key)) {
                settlePendingAsk(key, flowResultFromDesktopResponse(response.response));
                return;
              }
              await sessionAdapter.answerAsk(response);
            },
            onPlanResponse: async (response: DesktopPlanResponse) => {
              if (!planTransport?.handleResponse(response)) throw new Error("unknown_plan_response");
            },
            onDisconnected: () => {
              if (client !== candidate) return;
              client = undefined;
              for (const pending of pendingAskRequests.values()) {
                pending.sentGeneration = undefined;
              }
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
          const executionSummary = currentExecutionSummary();
          if (executionSummary) {
            await candidate.sendExecutionSummary({
              type: "desktop_plugin_event",
              event: "execution_summary",
              summary: executionSummary,
            }).catch(() => undefined);
          }
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
          await planTransport?.resendPending(candidate);
          if (!isCurrentSession(generation, sessionAdapter)) {
            abandonCandidate(candidate);
            return;
          }
          for (const pending of pendingAskRequests.values()) {
            if (!isCurrentSession(generation, sessionAdapter)) {
              abandonCandidate(candidate);
              return;
            }
            if (pending.sentGeneration === generation) continue;
            pending.sentGeneration = generation;
            try {
              await candidate.sendAskRequest(pending.request);
            } catch {
              pending.sentGeneration = undefined;
              scheduleReconnect(generation);
              break;
            }
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
      planTransport?.cancelAll();
      unregisterFlowPlanTransport?.();
      unregisterFlowPlanTransport = undefined;
      const target: DesktopPluginTarget = {
        sessionId: ctx.sessionManager.getSessionId(),
        endpointId: options.endpointId ?? `desktop-${randomUUID()}`,
        normalizedCwd: normalize(ctx.cwd),
        processGeneration: options.processGeneration ?? randomUUID(),
      };
      const targetSessionGeneration = sessionGeneration;
      activeTarget = target;
      queueMicrotask(() => {
        if (stopping || sessionGeneration !== targetSessionGeneration || activeTarget !== target) return;
        const projection = currentTeammateProjection(target.sessionId);
        if (projection) publishDesktopTargetIdentity(target, projection.generation);
      });
      executionSessionId = target.sessionId;
      executionTargetGeneration = target.processGeneration;
      executionTeammateProjection = currentTeammateProjection(target.sessionId);
      executionAgents = new Map();
      executionJobs = [];
      executionRevision = 0;
      executionFingerprint = "";
      const getEntries = (ctx.sessionManager as unknown as { getEntries?: () => unknown[] }).getEntries;
      executionTodoEntries = typeof getEntries === "function" ? () => getEntries.call(ctx.sessionManager) : undefined;
      planTransport = createDesktopPlanTransport({
        getClient: () => client,
        isCurrent: (request) => !stopping
          && request.sessionId === target.sessionId
          && normalize(request.cwd) === target.normalizedCwd,
      });
      unregisterFlowPlanTransport = registerFlowPlanTransport(planTransport);
      queueMicrotask(() => {
        if (executionSessionId === target.sessionId && executionTargetGeneration === target.processGeneration && !stopping) {
          eventBus?.emit("bash-bg:query", undefined);
          publishExecutionSummary();
        }
      });
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
      latestUsage = usageFromSessionEntries(sessionEntriesOf(ctx));
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

    const reconcileExecutionTeammateProjection = (): void => {
      if (!executionSessionId) return;
      const current = currentTeammateProjection(executionSessionId);
      const changed = executionTeammateProjection !== undefined
        && (current === undefined || !sameProjection(current, executionTeammateProjection));
      executionTeammateProjection = current;
      if (changed) {
        executionAgents.clear();
        executionFingerprint = "";
      }
    };

    const currentExecutionSummary = (): DesktopPluginExecutionSummary | undefined => {
      reconcileExecutionTeammateProjection();
      const todos = flowTodoSnapshot(executionTodoEntries?.());
      if (!todos) return undefined;
      const agents = [...executionAgents.values()].slice(0, 64);
      return {
        revision: executionRevision,
        todos,
        teammate: {
          running: agents.filter((agent) => agent.status === "running" || agent.status === "retrying").length,
          total: agents.length,
          agents,
        },
        backgroundJobs: executionJobs.slice(0, 64),
      };
    };

    const publishExecutionSummary = (): void => {
      if (!executionSessionId || !client) return;
      const next = currentExecutionSummary();
      if (!next) return;
      const fingerprint = JSON.stringify({ todos: next.todos, teammate: next.teammate, backgroundJobs: next.backgroundJobs });
      if (fingerprint === executionFingerprint && executionRevision > 0) return;
      executionFingerprint = fingerprint;
      executionRevision += 1;
      void client.sendExecutionSummary({
        type: "desktop_plugin_event",
        event: "execution_summary",
        summary: { ...next, revision: executionRevision },
      }).catch(() => undefined);
    };

    const updateExecutionAgent = (value: unknown): void => {
      if (!isRecord(value)) return;
      const correlationId = boundedText(value.correlationId);
      const agent = boundedText(value.agent);
      const status = boundedText(value.status, 64);
      if (!correlationId || !agent || !status) return;
      const name = boundedText(value.name);
      const phase = boundedText(value.phase, 64);
      if (executionAgents.has(correlationId)) executionAgents.delete(correlationId);
      while (executionAgents.size >= 64) executionAgents.delete(executionAgents.keys().next().value!);
      executionAgents.set(correlationId, {
        correlationId,
        agent,
        status,
        ...(name ? { name } : {}),
        ...(phase ? { phase } : {}),
      });
    };

    const currentExecutionTeammateProjection = (): typeof executionTeammateProjection => {
      reconcileExecutionTeammateProjection();
      return executionTeammateProjection;
    };

    const eventBus = (pi as unknown as { events?: { on(event: string, handler: (payload: unknown) => void): void; emit(event: string, payload: unknown): void } }).events;
    if (eventBus) {
      eventBus.on("teammate:started", (payload) => {
        if (!isRecord(payload)) return;
        const current = currentExecutionTeammateProjection();
        if (!current || !sameProjection(payload.projection, current)) return;
        updateExecutionAgent(payload);
        publishExecutionSummary();
      });
      eventBus.on("teammate:message", (payload) => {
        if (!isRecord(payload)) return;
        const current = currentExecutionTeammateProjection();
        if (!current || !sameProjection(payload.projection, current)) return;
        if (Array.isArray(payload.progress)) for (const agent of payload.progress) updateExecutionAgent(agent);
        publishExecutionSummary();
      });
      eventBus.on("teammate:complete", (payload) => {
        if (!isRecord(payload)) return;
        const current = currentExecutionTeammateProjection();
        if (!current || !sameProjection(payload.projection, current)) return;
        const correlationId = boundedText(payload.correlationId);
        if (correlationId) executionAgents.delete(correlationId);
        publishExecutionSummary();
      });
      eventBus.on("bash-bg:update", (payload) => {
        const generation = executionTargetGeneration;
        if (!generation) return;
        const jobs = backgroundSnapshot(payload);
        if (!jobs || executionTargetGeneration !== generation || stopping) return;
        executionJobs = jobs;
        publishExecutionSummary();
      });
      eventBus.on("maestro:todo-state-changed", () => publishExecutionSummary());
    }

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
      const role = (event as { message?: { role?: string } }).message?.role;
      const usage = usageProjection((event as { message?: { usage?: unknown } }).message?.usage);
      messageCount += 1;
      lastActivityAt = new Date().toISOString();
      if (role === "assistant" && usage) {
        latestUsage = addUsage(latestUsage, usage);
      }
      latestContext = readContextUsage(ctx);
      publishSummary();
    });
    pi.on("session_compact", (_event, ctx) => {
      messageCount = countStoredMessages(ctx);
      latestUsage = usageFromSessionEntries(sessionEntriesOf(ctx)) ?? latestUsage;
      latestContext = readContextUsage(ctx);
      lastActivityAt = new Date().toISOString();
      publishSummary();
    });
    pi.on("agent_end", (_event, ctx) => {
      latestUsage = usageFromSessionEntries(sessionEntriesOf(ctx)) ?? latestUsage;
      latestContext = readContextUsage(ctx);
      publishRuntimeStatus("idle");
    });

    pi.on("session_shutdown", async () => {
      const shutdownTarget = activeTarget;
      activeTarget = undefined;
      if (shutdownTarget) clearDesktopTargetIdentity(shutdownTarget);
      const shutdownGeneration = sessionGeneration;
      const shutdownAdapter = adapter;
      const shutdownAttempt = connectionAttempt?.generation === shutdownGeneration
        ? connectionAttempt.promise
        : undefined;
      stopping = true;
      sessionGeneration += 1;
      executionSessionId = undefined;
      executionTodoEntries = undefined;
      executionTargetGeneration = undefined;
      executionTeammateProjection = undefined;
      executionAgents.clear();
      executionJobs = [];
      adapter = undefined;
      for (const key of [...pendingAskRequests.keys()]) settlePendingAsk(key, { status: "cancelled" });
      unregisterFlowAskTransport?.();
      unregisterFlowAskTransport = undefined;
      planTransport?.cancelAll();
      unregisterFlowPlanTransport?.();
      unregisterFlowPlanTransport = undefined;
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
