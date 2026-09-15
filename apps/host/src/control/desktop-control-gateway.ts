import type { DesktopAskResponse, DesktopPluginOperation, DesktopPluginTarget, ExtensionUiResponse } from "@maestro-mobile/shared";
import { IdempotencyLedger } from "../control/idempotency-ledger.js";
import type { SessionCommand, CommandResult, DesktopControlGateway } from "../application/session-command-service.js";
import type { SessionTargetIdentity } from "../control/SessionDirectory.js";
import { DesktopPluginRegistry } from "../plugin/desktop-plugin-registry.js";

const DEFAULT_GATEWAY_DEADLINE_MS = 2_000;

type Image = { data: string; mime: string };

function isImage(value: unknown): value is Image {
  return typeof value === "object" && value !== null
    && typeof (value as { data?: unknown }).data === "string"
    && typeof (value as { mime?: unknown }).mime === "string";
}

function desktopOperation(command: SessionCommand): DesktopPluginOperation | { error: string } {
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

export class DesktopControlGatewayService implements DesktopControlGateway {
  private readonly ledger = new IdempotencyLedger<CommandResult>();

  constructor(
    private readonly registry: DesktopPluginRegistry,
    private readonly deadlineMs = DEFAULT_GATEWAY_DEADLINE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  execute(command: SessionCommand): Promise<CommandResult> {
    return this.ledger.run(command.requestId, command.kind, async () => {
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

  answerAsk(target: SessionTargetIdentity, requestId: string, toolCallId: string, response: ExtensionUiResponse): Promise<CommandResult> {
    return this.ledger.run(requestId, "ask_response", async () => {
      const desktopTarget = targetOf({ requestId, target, kind: "abort" });
      const registration = this.registry.resolve(desktopTarget);
      if (!registration) return { requestId, operation: "ask_response", status: "unknown", revision: this.registry.revision, error: { code: "target_unavailable" } };
      if (!this.registry.hasCapability(desktopTarget, "ask-user-question") || !registration.transport.answerAsk) {
        return { requestId, operation: "ask_response", status: "failed", revision: this.registry.revision, error: { code: "unsupported_capability" } };
      }
      const message: DesktopAskResponse = { type: "desktop_ask_response", requestId, toolCallId, response };
      try {
        registration.transport.answerAsk(message);
        return { requestId, operation: "ask_response", status: "accepted", revision: this.registry.revision };
      } catch {
        return { requestId, operation: "ask_response", status: "unknown", revision: this.registry.revision, error: { code: "desktop_confirmation_unavailable" } };
      }
    });
  }

  clearIdempotency(): void {
    this.ledger.clear();
  }
}

