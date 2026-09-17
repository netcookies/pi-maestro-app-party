import { normalize } from "node:path";
import type { SessionPresentation } from "@maestro-mobile/shared";
import type { DesktopPluginCapability, DesktopPluginTarget } from "@maestro-mobile/shared";
import type { SessionRunner } from "../types.js";

export type SessionControlCapability = "prompt" | "steer" | "follow_up" | "abort" | "set_model" | "ask";

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

function presentationForTarget(
  kind: SessionDirectoryTarget["kind"],
  capabilities: readonly SessionControlCapability[],
  revision: number,
): SessionPresentation {
  const available = new Set(capabilities);
  return {
    role: "session",
    visibility: "session_list",
    control: {
      mode: kind === "host" ? "host" : "desktop_plugin",
      canPrompt: available.has("prompt"),
      canSteer: available.has("steer"),
      canFollowUp: available.has("follow_up"),
      canAbort: available.has("abort"),
      canAnswerAsk: available.has("ask"),
    },
    revision,
  };
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
    const capabilities: SessionControlCapability[] = ["prompt", "steer", "follow_up", "abort", "set_model"];
    const presentation = presentationForTarget("host", capabilities, this._revision + 1);
    this.register({
      identity,
      kind: "host",
      capabilities,
      runner,
      presentation,
    });
    return identity;
  }

  registerDesktopTarget(target: DesktopPluginTarget, capabilities: readonly DesktopPluginCapability[]): SessionTargetIdentity {
    const controlCapabilities: SessionControlCapability[] = [];
    for (const capability of capabilities) {
      if (capability === "prompt" || capability === "steer" || capability === "follow_up" || capability === "abort" || capability === "set_model") {
        controlCapabilities.push(capability);
      } else if (capability === "ask-user-question") {
        controlCapabilities.push("ask");
      }
    }
    const identity: SessionTargetIdentity = {
      sessionId: target.sessionId,
      endpointId: target.endpointId,
      normalizedCwd: normalize(target.normalizedCwd),
      processGeneration: target.processGeneration,
    };
    const existing = this.resolve(identity);
    this.register({
      identity,
      kind: "desktop",
      capabilities: controlCapabilities,
      ...(existing?.runner ? { runner: existing.runner } : {}),
    });
    return identity;
  }
  register(target: SessionDirectoryTarget): void {
    const normalizedIdentity = { ...target.identity, normalizedCwd: normalize(target.identity.normalizedCwd) };
    const capabilities = [...target.capabilities];
    const presentation = target.presentation ?? presentationForTarget(target.kind, capabilities, this._revision + 1);
    if (target.runner) target.runner.state.presentation = presentation;
    this.targets.set(keyOf(normalizedIdentity), {
      ...target,
      identity: normalizedIdentity,
      capabilities,
      presentation,
    });
    this._revision += 1;
  }

  attachRunner(identity: SessionTargetIdentity, runner: SessionRunner): boolean {
    const target = this.resolve(identity);
    if (!target || target.identity.sessionId !== runner.id || target.identity.normalizedCwd !== normalize(runner.state.cwd)) return false;
    if (target.runner === runner) {
      if (target.presentation) runner.state.presentation = target.presentation;
      return true;
    }
    this.register({ ...target, runner });
    return true;
  }

  detachRunner(identity: SessionTargetIdentity, expectedRunner?: SessionRunner): boolean {
    const target = this.resolve(identity);
    if (!target?.runner || (expectedRunner && target.runner !== expectedRunner)) return false;
    const { runner: _runner, ...withoutRunner } = target;
    this.register(withoutRunner);
    return true;
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
