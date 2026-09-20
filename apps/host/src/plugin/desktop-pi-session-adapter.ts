import type { DesktopAskRequest, DesktopAskResponse, DesktopPluginCapability, DesktopPluginRequest, DesktopPluginResult, DesktopPluginTarget, JsonValue } from "@maestro-mobile/shared";
import { DesktopFlowAskAdapter } from "./desktop-flow-ask-adapter.js";

export interface DesktopPiSessionApi {
  prompt(message: string, images?: unknown[]): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void> | void;
  getAllTools(): readonly { name?: string }[];
  setModel(provider: string | undefined, modelId: string): Promise<boolean>;
  setThinking(level: string): void;
}

/** 投递失败的错误码；Host/移动端据此区分「未投递」与「插件异常」。 */
export const DELIVERY_FAILED = "delivery_failed";

/**
 * Pi 的 `sendUserMessage` 返回 void 且失败被 SDK 吞进 emitError，调用方无法 await 或 catch。
 * 因此必须在调用前判定可预见的投递失败，并用携带 code 的错误把它变成可观测结果。
 */
export function deliveryFailure(reason: string): Error & { code: string } {
  const error = new Error(reason) as Error & { code: string };
  error.code = DELIVERY_FAILED;
  return error;
}

/** 从任意抛出物中取回结构化错误码，未携带时回退到通用插件失败码。 */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? code : "plugin_command_failed";
}

function capabilityFor(request: DesktopPluginRequest): DesktopPluginCapability {
  return request.operation.type === "follow_up" ? "follow_up" : request.operation.type;
}

function sameTarget(a: DesktopPluginTarget, b: DesktopPluginTarget): boolean {
  return a.sessionId === b.sessionId
    && a.endpointId === b.endpointId
    && a.normalizedCwd === b.normalizedCwd
    && a.processGeneration === b.processGeneration;
}

export class DesktopPiSessionAdapter {
  readonly target: DesktopPluginTarget;
  readonly ask: DesktopFlowAskAdapter;
  private readonly capabilities: DesktopPluginCapability[];

  constructor(
    private readonly api: DesktopPiSessionApi,
    target: DesktopPluginTarget,
    ask = DesktopFlowAskAdapter.fromTools(api.getAllTools()),
  ) {
    this.target = { ...target };
    this.ask = ask;
    this.capabilities = ["prompt", "steer", "follow_up", "abort", "set_model", "set_thinking", ...(ask.supported ? ["ask-user-question" as const] : [])];
  }

  getCapabilities(): DesktopPluginCapability[] {
    return [...this.capabilities];
  }

  observeToolCall(event: { toolCallId: string; toolName: string; input?: Record<string, unknown>; expiresAt?: number }): DesktopAskRequest | undefined {
    if (!this.ask.supported || event.toolName !== "ask-user-question") return undefined;
    const questions = event.input?.questions;
    if (!Array.isArray(questions)) return undefined;
    if (!this.ask.register(event.toolCallId, questions, event.expiresAt)) return undefined;
    let jsonQuestions: JsonValue[];
    try {
      jsonQuestions = JSON.parse(JSON.stringify(questions)) as JsonValue[];
    } catch {
      return undefined;
    }
    const expiresAt = event.expiresAt ?? Date.now() + 120_000;
    return { type: "desktop_ask_request", requestId: `question:${event.toolCallId}`, toolCallId: event.toolCallId, questions: jsonQuestions, deadlineAt: expiresAt };
  }

  async answerAsk(response: DesktopAskResponse): Promise<void> {
    const result = await this.ask.answer(response.toolCallId, response.response);
    if (result.status === "failed") throw new Error(result.error?.code ?? "ask_response_failed");
  }

  async execute(request: DesktopPluginRequest): Promise<DesktopPluginResult> {
    const operation = request.operation.type;
    if (!sameTarget(request.target, this.target)) {
      return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "failed", error: { code: "target_mismatch" } };
    }
    if (!this.capabilities.includes(capabilityFor(request))) {
      return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "failed", error: { code: "capability_mismatch" } };
    }
    try {
      if (operation === "prompt") {
        await this.api.prompt(request.operation.message, request.operation.images);
        // `ExtensionAPI.sendUserMessage()` 是 fire-and-forget；这里只能确认请求已被接受。
        return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "accepted" };
      }
      if (operation === "steer") {
        await this.api.steer(request.operation.message);
        return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "accepted" };
      }
      if (operation === "follow_up") {
        await this.api.followUp(request.operation.message);
        return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "accepted" };
      }
      if (operation === "set_model") {
        const changed = await this.api.setModel(request.operation.provider, request.operation.modelId);
        if (!changed) return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "failed", error: { code: "model_change_failed" } };
      } else if (operation === "set_thinking") {
        this.api.setThinking(request.operation.level);
        return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "accepted" };
      } else {
        await this.ask.cancelAll();
        await this.api.abort();
      }
      return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "observed" };
    } catch (error) {
      return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "failed", error: { code: errorCodeOf(error), message: error instanceof Error ? error.message : undefined } };
    }
  }

  async dispose(): Promise<void> {
    await this.ask.cancelAll();
  }
}
