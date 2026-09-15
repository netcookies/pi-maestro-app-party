import { normalize } from "node:path";
import type { SessionPresentation } from "@maestro-mobile/shared";
import type { DesktopPluginCapability, DesktopPluginTarget } from "@maestro-mobile/shared";
import type { SessionRunner } from "../types.js";

export type SessionControlCapability = "prompt" | "steer" | "follow_up" | "abort" | "ask";

export interface SessionTargetIdentity {
  sessionId: string;
  endpointId: string;
  normalizedCwd: string;
  processGeneration: string;
}

export interface SessionDirectoryTarget {
  identity: SessionTargetIdentity;
  kind: "host" | "desktop";
  capabilities: readonly SessionControlCapability[];
  runner?: SessionRunner;
  presentation?: SessionPresentation;
}

function keyOf(identity: SessionTargetIdentity): string {
  return [identity.sessionId, identity.endpointId, identity.normalizedCwd, identity.processGeneration].join("\u0000");
}

export class SessionDirectory {
  private readonly targets = new Map<string, SessionDirectoryTarget>();
  private readonly generations = new Map<string, number>();
  private _revision = 0;

  get revision(): number {
    return this._revision;
  }

  registerHostRunner(runner: SessionRunner): SessionTargetIdentity {
    const count = (this.generations.get(runner.id) ?? 0) + 1;
    this.generations.set(runner.id, count);
    const identity: SessionTargetIdentity = {
      sessionId: runner.id,
      endpointId: "host",
      normalizedCwd: normalize(runner.state.cwd),
      processGeneration: `host-${runner.id}-${count}`,
    };
    this.register({
      identity,
      kind: "host",
      capabilities: ["prompt", "steer", "follow_up", "abort"],
      runner,
      presentation: runner.state.presentation,
    });
    return identity;
  }

  registerDesktopTarget(target: DesktopPluginTarget, capabilities: readonly DesktopPluginCapability[]): SessionTargetIdentity {
    const controlCapabilities = capabilities.filter((capability) =>
      capability === "prompt" || capability === "steer" || capability === "follow_up" || capability === "abort") as SessionControlCapability[];
    const identity: SessionTargetIdentity = {
      sessionId: target.sessionId,
      endpointId: target.endpointId,
      normalizedCwd: normalize(target.normalizedCwd),
      processGeneration: target.processGeneration,
    };
    this.register({ identity, kind: "desktop", capabilities: controlCapabilities });
    return identity;
  }
  register(target: SessionDirectoryTarget): void {
    const identity = { ...target.identity, normalizedCwd: normalize(target.identity.normalizedCwd) };
    this.targets.set(keyOf(identity), {
      ...target,
      identity,
      capabilities: [...target.capabilities],
    });
    this._revision += 1;
  }

  unregister(identity: SessionTargetIdentity): boolean {
    const removed = this.targets.delete(keyOf(identity));
    if (removed) this._revision += 1;
    return removed;
  }

  resolve(identity: SessionTargetIdentity, capability?: SessionControlCapability): SessionDirectoryTarget | undefined {
    const target = this.targets.get(keyOf(identity));
    if (!target) return undefined;
    if (capability && !target.capabilities.includes(capability)) return undefined;
    return target;
  }

  list(): SessionDirectoryTarget[] {
    return [...this.targets.values()].map((target) => ({
      ...target,
      capabilities: [...target.capabilities],
    }));
  }
}
