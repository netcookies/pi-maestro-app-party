import type { JsonValue, OperationReceipt, OperationStatus } from "@maestro-mobile/shared";
import { IdempotencyLedger } from "../control/idempotency-ledger.js";
import type { SessionDirectory, SessionTargetIdentity } from "../control/SessionDirectory.js";

export type SessionCommandKind = "prompt" | "steer" | "follow_up" | "abort";

export interface SessionCommand {
  requestId: string;
  target: SessionTargetIdentity;
  kind: SessionCommandKind;
  message?: string;
  images?: unknown[];
}

export interface CommandResult extends OperationReceipt {
  error?: { code: string; message?: string };
  result?: JsonValue;
}

export interface DesktopControlGateway {
  execute(command: SessionCommand): Promise<CommandResult>;
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
    return this.ledger.run(command.requestId, command.kind, async () => {
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
        else await runner.abort();
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
