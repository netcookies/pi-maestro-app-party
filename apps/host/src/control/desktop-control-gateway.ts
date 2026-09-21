import { randomUUID } from "node:crypto";
import type {
  DesktopAskResponse,
  DesktopAskResult,
  DesktopPluginCapability,
  DesktopPluginOperation,
  DesktopPluginRequest,
  DesktopPluginResult,
  DesktopPluginTarget,
  ExtensionUiResponse,
} from "@maestro-mobile/shared";
import { IdempotencyLedger } from "../control/idempotency-ledger.js";
import type { SessionCommand, CommandResult, DesktopControlGateway } from "../application/session-command-service.js";
import type { SessionTargetIdentity } from "../control/SessionDirectory.js";
const DEFAULT_GATEWAY_DEADLINE_MS = 2_000;

interface DesktopPluginRegistryLike {
  readonly revision: number;
  resolve(target: DesktopPluginTarget): {
    capabilities: readonly DesktopPluginCapability[];
    transport: {
      request(request: DesktopPluginRequest): Promise<DesktopPluginResult>;
      answerAsk?(response: DesktopAskResponse): Promise<DesktopAskResult>;
    };
  } | undefined;
  hasCapability(target: DesktopPluginTarget, capability: DesktopPluginCapability): boolean;
}


type Image = { data: string; mime: string };

function isImage(value: unknown): value is Image {
  return typeof value === "object" && value !== null
    && typeof (value as { data?: unknown }).data === "string"
    && typeof (value as { mime?: unknown }).mime === "string";
}

function desktopOperation(command: SessionCommand): DesktopPluginOperation | { error: string } {
  if (command.kind === "set_model") {
    if (typeof command.modelId !== "string" || command.modelId.length === 0) return { error: "model_required" };
    return { type: "set_model", modelId: command.modelId, ...(command.provider ? { provider: command.provider } : {}) };
  }
  if (command.kind === "set_thinking") {
    if (typeof command.level !== "string" || command.level.length === 0) return { error: "thinking_level_required" };
    return { type: "set_thinking", level: command.level };
  }
  if (command.kind === "abort") return { type: "abort" };
  if (typeof command.message !== "string") return { error: "message_required" };
  if (command.kind === "prompt") {
    const images = command.images?.map((image) => isImage(image) ? image : undefined);
    if (images?.some((image): image is undefined => image === undefined)) return { error: "invalid_image" };
    return { type: "prompt", message: command.message, ...(images && images.length > 0 ? { images: images as Image[] } : {}) };
  }
  return { type: command.kind, message: command.message };
}

function targetOf(command: SessionCommand): DesktopPluginTarget {
  return {
    sessionId: command.target.sessionId,
    endpointId: command.target.endpointId,
    normalizedCwd: command.target.normalizedCwd,
    processGeneration: command.target.processGeneration,
  };
}

function commandScope(command: SessionCommand): string {
  return JSON.stringify([command.kind, command.target.sessionId, command.target.endpointId, command.target.normalizedCwd, command.target.processGeneration]);
}

export class DesktopControlGatewayService implements DesktopControlGateway {
  private readonly ledger = new IdempotencyLedger<CommandResult>();

  constructor(
    private readonly registry: DesktopPluginRegistryLike,
    private readonly deadlineMs = DEFAULT_GATEWAY_DEADLINE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  execute(command: SessionCommand): Promise<CommandResult> {
    return this.ledger.run(command.requestId, commandScope(command), async () => {
      const target = targetOf(command);
      const registration = this.registry.resolve(target);
      if (!registration) {
        return { requestId: command.requestId, operation: command.kind, status: "unknown", revision: this.registry.revision, error: { code: "target_unavailable" } };
      }
      if (!this.registry.hasCapability(target, command.kind)) {
        return { requestId: command.requestId, operation: command.kind, status: "failed", revision: this.registry.revision, error: { code: "capability_mismatch" } };
      }
      const operation = desktopOperation(command);
      if ("error" in operation) {
        return { requestId: command.requestId, operation: command.kind, status: "failed", revision: this.registry.revision, error: { code: operation.error } };
      }
      const request = {
        type: "desktop_plugin_request" as const,
        requestId: command.requestId,
        commandId: command.requestId,
        deadlineAt: this.now() + this.deadlineMs,
        target,
        operation,
      };
      try {
        const response = await registration.transport.request(request);
        return {
          requestId: command.requestId,
          operation: command.kind,
          status: response.status,
          revision: this.registry.revision,
          ...(response.result !== undefined ? { result: response.result } : {}),
          ...(response.error ? { error: response.error } : {}),
        };
      } catch (error) {
        const code = error instanceof Error && error.message.includes("deadline") ? "deadline_exceeded" : "desktop_confirmation_unavailable";
        return { requestId: command.requestId, operation: command.kind, status: "unknown", revision: this.registry.revision, error: { code } };
      }
    });
  }

  query(target: SessionTargetIdentity, operation: "list_models" | "list_skills"): Promise<unknown> {
    const desktopTarget: DesktopPluginTarget = {
      sessionId: target.sessionId,
      endpointId: target.endpointId,
      normalizedCwd: target.normalizedCwd,
      processGeneration: target.processGeneration,
    };
    const requestId = `query:${randomUUID()}`;
    const registration = this.registry.resolve(desktopTarget);
    if (!registration || !this.registry.hasCapability(desktopTarget, operation)) return Promise.resolve([]);
    return registration.transport.request({
      type: "desktop_plugin_request",
      requestId,
      commandId: requestId,
      deadlineAt: this.now() + this.deadlineMs,
      target: desktopTarget,
      operation: { type: operation },
    }).then((response) => response.status === "observed" && response.result !== undefined ? response.result : []).catch(() => []);
  }
  answerAsk(target: SessionTargetIdentity, requestId: string, toolCallId: string, response: ExtensionUiResponse): Promise<CommandResult> {
    const scope = JSON.stringify(["ask_response", target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration, toolCallId]);
    const receipt = this.ledger.run(requestId, scope, async () => {
      const desktopTarget = targetOf({ requestId, target, kind: "abort" });
      const registration = this.registry.resolve(desktopTarget);
      if (!registration) return { requestId, operation: "ask_response", status: "unknown", revision: this.registry.revision, error: { code: "target_unavailable" } };
      if (!this.registry.hasCapability(desktopTarget, "ask-user-question") || !registration.transport.answerAsk) {
        return { requestId, operation: "ask_response", status: "failed", revision: this.registry.revision, error: { code: "unsupported_capability" } };
      }
      const message: DesktopAskResponse = { type: "desktop_ask_response", requestId, toolCallId, response };
      try {
        const result = await registration.transport.answerAsk(message);
        if (result.status !== "accepted") {
          return {
            requestId,
            operation: "ask_response",
            status: result.status,
            revision: this.registry.revision,
            ...(result.error ? { error: result.error } : { error: { code: "desktop_ask_rejected" } }),
          };
        }
        return { requestId, operation: "ask_response", status: "accepted", revision: this.registry.revision };
      } catch {
        return { requestId, operation: "ask_response", status: "unknown", revision: this.registry.revision, error: { code: "desktop_confirmation_unavailable" } };
      }
    });
    return receipt.then((result) => {
      if (result.status !== "accepted") this.ledger.forget(requestId, scope, receipt);
      return result;
    });
  }

  clearIdempotency(): void {
    this.ledger.clear();
  }
}

