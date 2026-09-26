import type { HostError, JsonValue, OperationReceipt, OperationStatus } from "@maestro-mobile/shared";
import { normalizeHostError } from "../host-error.js";
import { IdempotencyLedger } from "../control/idempotency-ledger.js";
import type { SessionDirectory, SessionTargetIdentity } from "../control/SessionDirectory.js";

export type SessionCommandKind = "prompt" | "steer" | "follow_up" | "abort" | "set_model" | "set_thinking";


export interface SessionCommand {
  requestId: string;
  target: SessionTargetIdentity;
  kind: SessionCommandKind;
  message?: string;
  modelId?: string;
  provider?: string;
  level?: string;
  images?: unknown[];
}

export interface CommandResult extends OperationReceipt {
  error?: { code: string; message?: string; details?: HostError };
  result?: JsonValue;
}

export interface DesktopControlGateway {
  execute(command: SessionCommand): Promise<CommandResult>;
  query(target: SessionTargetIdentity, operation: "list_models" | "list_skills"): Promise<unknown>;
}

function commandScope(command: SessionCommand): string {
  return JSON.stringify([command.kind, command.target.sessionId, command.target.endpointId, command.target.normalizedCwd, command.target.processGeneration]);
}

function result(
  command: SessionCommand,
  revision: number,
  status: OperationStatus,
  error?: { code: string; message?: string; details?: HostError },
): CommandResult {
  return {
    requestId: command.requestId,
    operation: command.kind,
    status,
    revision,
    ...(error ? { error } : {}),
  };
}

export class SessionCommandService {
  private readonly ledger = new IdempotencyLedger<CommandResult>();

  constructor(
    private readonly directory: SessionDirectory,
    private readonly desktopGateway?: DesktopControlGateway,
  ) {}

  execute(command: SessionCommand): Promise<CommandResult> {
    return this.ledger.run(command.requestId, commandScope(command), async () => {
      const target = this.directory.resolve(command.target, command.kind);
      if (!target) return result(command, this.directory.revision, "unknown", { code: "target_unavailable" });

      if (target.kind !== "desktop") return result(command, this.directory.revision, "unknown", { code: "target_unavailable" });
      if (!this.desktopGateway) {
        return result(command, this.directory.revision, "unknown", { code: "desktop_gateway_unavailable" });
      }
      try {
        const response = await this.desktopGateway.execute(command);
        return { ...response, requestId: command.requestId, operation: command.kind, revision: this.directory.revision };
      } catch (error) {
        const details = normalizeHostError(error, "transport");
        return result(command, this.directory.revision, "unknown", { code: details.code, message: details.message, details });
      }
    });
  }

  clearIdempotency(): void {
    this.ledger.clear();
  }
}
