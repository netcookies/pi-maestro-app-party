import type { JsonValue, OperationReceipt, OperationStatus } from "@maestro-mobile/shared";
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
  error?: { code: string; message?: string };
  result?: JsonValue;
}

export interface DesktopControlGateway {
  execute(command: SessionCommand): Promise<CommandResult>;
}

function commandScope(command: SessionCommand): string {
  return JSON.stringify([command.kind, command.target.sessionId, command.target.endpointId, command.target.normalizedCwd, command.target.processGeneration]);
}

function result(
  command: SessionCommand,
  revision: number,
  status: OperationStatus,
  error?: { code: string; message?: string },
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

      if (target.kind === "desktop") {
        if (!this.desktopGateway) {
          return result(command, this.directory.revision, "unknown", { code: "desktop_gateway_unavailable" });
        }
        try {
          const response = await this.desktopGateway.execute(command);
          return { ...response, requestId: command.requestId, operation: command.kind, revision: this.directory.revision };
        } catch {
          return result(command, this.directory.revision, "unknown", { code: "desktop_confirmation_unavailable" });
        }
      }

      const runner = target.runner;
      if (!runner) return result(command, this.directory.revision, "unknown", { code: "host_runner_unavailable" });
      try {
        if (command.kind === "prompt") {
          if (runner.state.runState === "streaming") await runner.steer(command.message ?? "");
          else await runner.prompt(command.message ?? "", undefined, command.images);
        } else if (command.kind === "steer") await runner.steer(command.message ?? "");
        else if (command.kind === "follow_up") await runner.followUp(command.message ?? "");
        else if (command.kind === "set_model") {
          if (!command.modelId || typeof runner.setModel !== "function") throw new Error("model_unavailable");
          const changed = await runner.setModel(command.modelId, command.provider);
          if (!changed.ok) return result(command, this.directory.revision, "failed", { code: changed.error ?? "model_change_failed" });
        } else if (command.kind === "set_thinking") {
          if (!command.level || typeof runner.setThinking !== "function") throw new Error("thinking_unavailable");
          const changed = runner.setThinking(command.level);
          if (!changed.ok) return result(command, this.directory.revision, "failed", { code: changed.error ?? "thinking_change_failed" });
        } else await runner.abort();
        return result(command, this.directory.revision, "observed");
      } catch {
        return result(command, this.directory.revision, "failed", { code: "host_command_failed" });
      }
    });
  }

  clearIdempotency(): void {
    this.ledger.clear();
  }
}
