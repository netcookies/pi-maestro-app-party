import { randomUUID } from "node:crypto";
import type { DesktopPluginTarget } from "@maestro-mobile/shared";
import { HerdrAdapter, HerdrAdapterError, type HerdrServerStatus } from "./herdr-adapter.js";

export interface HerdrLaunchRegistry {
  readonly epoch: string | undefined;
  readonly isValid: boolean;
  list(): Array<{ target: DesktopPluginTarget; launchNonce?: string }>;
}

export interface HerdrLaunchEvent {
  requestId: string;
  status: "accepted" | "ready" | "failed" | "unknown";
  stage: string;
  paneId?: string;
  target?: DesktopPluginTarget;
  error?: { code: string; message: string; source: "command" };
}

interface PendingLaunch {
  promise: Promise<HerdrLaunchEvent>;
  createdAt: number;
}

const PENDING_TTL_MS = 5 * 60_000;
const REGISTRATION_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

export class HerdrSessionLaunchService {
  private readonly pending = new Map<string, PendingLaunch>();

  constructor(
    private readonly registry: HerdrLaunchRegistry,
    private readonly adapter = new HerdrAdapter(),
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async status(): Promise<HerdrServerStatus> {
    return this.adapter.probe();
  }

  async launch(requestId: string, cwd: string, label?: string): Promise<HerdrLaunchEvent> {
    this.prune();
    const existing = this.pending.get(requestId);
    if (existing) return existing.promise;
    const promise = this.performLaunch(requestId, cwd, label);
    this.pending.set(requestId, { promise, createdAt: this.now() });
    const result = await promise;
    if (result.status === "ready" || result.status === "failed") this.pending.set(requestId, { promise: Promise.resolve(result), createdAt: this.now() });
    return result;
  }

  private async performLaunch(requestId: string, cwd: string, label?: string): Promise<HerdrLaunchEvent> {
    const expectedEpoch = this.registry.epoch;
    if (!this.registry.isValid || !expectedEpoch) {
      return { requestId, status: "unknown", stage: "broker_projection_unavailable" };
    }
    try {
      const launched = await this.adapter.launchPiPane({ requestId, cwd, label });
      const deadline = this.now() + REGISTRATION_TIMEOUT_MS;
      while (this.now() < deadline) {
        if (!this.registry.isValid || this.registry.epoch !== expectedEpoch) {
          return { requestId, status: "unknown", stage: "broker_epoch_changed", paneId: launched.paneId };
        }
        const matches = this.registry.list().filter((registration) => registration.launchNonce === launched.launchNonce);
        if (matches.length > 1) return { requestId, status: "failed", stage: "plugin_registered", paneId: launched.paneId, error: { code: "launch_nonce_ambiguous", message: "Multiple Pi sessions reported the launch nonce", source: "command" } };
        const match = matches[0];
        if (match) {
          const expectedCwd = await import("node:fs/promises").then(({ realpath }) => realpath(cwd));
          if (match.target.normalizedCwd !== expectedCwd) return { requestId, status: "failed", stage: "plugin_registered", paneId: launched.paneId, error: { code: "launch_target_mismatch", message: "Registered Pi cwd does not match the requested cwd", source: "command" } };
          return { requestId, status: "ready", stage: "ready", paneId: launched.paneId, target: { ...match.target } };
        }
        await this.sleep(POLL_INTERVAL_MS);
      }
      return { requestId, status: "unknown", stage: "registration_timeout", paneId: launched.paneId, error: { code: "registration_timeout", message: "Pi started but did not register before the deadline", source: "command" } };
    } catch (error) {
      if (error instanceof HerdrAdapterError) {
        const sideEffectMayHaveOccurred = error.stage === "create_pane" || error.stage === "start_pi";
        return {
          requestId,
          status: sideEffectMayHaveOccurred ? "unknown" : "failed",
          stage: sideEffectMayHaveOccurred ? `${error.stage}_outcome_unknown` : error.stage,
          error: {
            code: sideEffectMayHaveOccurred ? "herdr_operation_outcome_unknown" : error.code,
            message: error.message,
            source: "command",
          },
        };
      }
      return { requestId, status: "unknown", stage: "outcome_unknown", error: { code: "herdr_operation_failed", message: error instanceof Error ? error.message.slice(0, 256) : "Herdr launch failed", source: "command" } };
    }
  }

  private prune(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [id, value] of this.pending) if (value.createdAt < cutoff) this.pending.delete(id);
  }
}

export function newHerdrLaunchRequestId(): string {
  return randomUUID();
}
