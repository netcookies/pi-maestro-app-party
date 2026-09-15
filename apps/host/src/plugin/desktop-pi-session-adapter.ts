import type {
  DesktopAskRequest,
  DesktopAskResponse,
  DesktopPluginCapability,
  DesktopPluginRequest,
  DesktopPluginResult,
  DesktopPluginTarget,
  JsonValue,
} from "@maestro-mobile/shared";
import { DesktopFlowAskAdapter } from "./desktop-flow-ask-adapter.js";

export interface DesktopPiSessionApi {
  prompt(message: string, images?: unknown[]): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void> | void;
  getAllTools(): readonly { name?: string }[];
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
    this.capabilities = ["prompt", "steer", "follow_up", "abort", ...(ask.supported ? ["ask-user-question" as const] : [])];
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
      if (operation === "prompt") await this.api.prompt(request.operation.message, request.operation.images);
      else if (operation === "steer") await this.api.steer(request.operation.message);
      else if (operation === "follow_up") await this.api.followUp(request.operation.message);
      else {
        await this.ask.cancelAll();
        await this.api.abort();
      }
      return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "observed" };
    } catch {
      return { type: "desktop_plugin_result", requestId: request.requestId, operation, status: "failed", error: { code: "plugin_command_failed" } };
    }
  }

  async dispose(): Promise<void> {
    await this.ask.cancelAll();
  }
}
