import { normalize } from "node:path";
import type { SessionContextUsage, SessionPresentation, SessionRuntimeStatus, SessionSummaryPatch, SessionTargetIdentity, SessionUsageTotals } from "@maestro-mobile/shared";
import type { DesktopPluginCapability, DesktopPluginModel, DesktopPluginRuntimeStatus, DesktopPluginTarget } from "@maestro-mobile/shared";
import type { SessionRunner } from "../types.js";

export type { SessionTargetIdentity } from "@maestro-mobile/shared";

export type SessionControlCapability = "prompt" | "steer" | "follow_up" | "abort" | "set_model" | "set_thinking" | "ask";

export interface SessionDirectoryTarget {
  identity: SessionTargetIdentity;
  kind: "host" | "desktop";
  capabilities: readonly SessionControlCapability[];
  /** Reader metadata supplied by the exact Desktop runtime; not part of identity. */
  sessionFile?: string;
  model?: DesktopPluginModel;
  thinkingLevel?: string;
  runner?: SessionRunner;
  presentation?: SessionPresentation;
  runtimeStatus?: SessionRuntimeStatus;
  activeSince?: string;
  lastActivityAt?: string;
  messageCount?: number;
  usage?: SessionUsageTotals;
  context?: SessionContextUsage | null;
  summaryRevision?: number;
}

export interface SessionSummaryUpdate {
  target: SessionDirectoryTarget;
  patch: SessionSummaryPatch;
  revision: number;
}

function keyOf(identity: SessionTargetIdentity): string {
  return [identity.sessionId, identity.endpointId, identity.normalizedCwd, identity.processGeneration].join("\u0000");
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    const capabilities: SessionControlCapability[] = ["prompt", "steer", "follow_up", "abort", "set_model", "set_thinking"];
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

  registerDesktopTarget(
    target: DesktopPluginTarget,
    capabilities: readonly DesktopPluginCapability[],
    metadata: { sessionFile?: string; model?: DesktopPluginModel; thinkingLevel?: string } = {},
  ): SessionTargetIdentity {
    const controlCapabilities: SessionControlCapability[] = [];
    for (const capability of capabilities) {
      if (capability === "prompt" || capability === "steer" || capability === "follow_up" || capability === "abort" || capability === "set_model" || capability === "set_thinking") {
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
      ...existing,
      identity,
      kind: "desktop",
      capabilities: controlCapabilities,
      presentation: existing && sameValue(existing.capabilities, controlCapabilities) ? existing.presentation : undefined,
      sessionFile: metadata.sessionFile,
      model: metadata.model ? { ...metadata.model } : existing?.model,
      thinkingLevel: metadata.thinkingLevel ?? existing?.thinkingLevel,
      ...(existing?.runner ? { runner: existing.runner } : {}),
      runtimeStatus: existing?.runtimeStatus ?? "idle",
    });
    return identity;
  }

  updateDesktopModel(identity: SessionTargetIdentity, model?: DesktopPluginModel): boolean {
    const key = keyOf({ ...identity, normalizedCwd: normalize(identity.normalizedCwd) });
    const target = this.targets.get(key);
    if (!target || target.kind !== "desktop") return false;
    if (sameValue(target.model, model)) return true;
    const next = { ...target };
    if (model === undefined) delete next.model;
    else next.model = { ...model };
    this.register(next);
    return true;
  }

  updateDesktopThinking(identity: SessionTargetIdentity, level: string | undefined): boolean {
    const key = keyOf({ ...identity, normalizedCwd: normalize(identity.normalizedCwd) });
    const target = this.targets.get(key);
    if (!target || target.kind !== "desktop") return false;
    if (target.thinkingLevel === level) return true;
    const next = { ...target };
    if (level === undefined) delete next.thinkingLevel;
    else next.thinkingLevel = level;
    this.register(next);
    return true;
  }

  clearDesktopSummary(identity: SessionTargetIdentity, runtimeStatus: DesktopPluginRuntimeStatus): boolean {
    const key = keyOf({ ...identity, normalizedCwd: normalize(identity.normalizedCwd) });
    const target = this.targets.get(key);
    if (!target || target.kind !== "desktop") return false;
    const next = { ...target, runtimeStatus };
    delete next.activeSince;
    delete next.lastActivityAt;
    delete next.messageCount;
    delete next.usage;
    delete next.context;
    delete next.summaryRevision;
    this.register(next);
    return true;
  }

  updateDesktopRuntimeStatus(identity: SessionTargetIdentity, runtimeStatus: DesktopPluginRuntimeStatus): boolean {
    return this.updateDesktopSummary(identity, { runtimeStatus }) !== undefined;
  }

  updateDesktopSummary(identity: SessionTargetIdentity, patch: SessionSummaryPatch): SessionSummaryUpdate | undefined {
    const key = keyOf({ ...identity, normalizedCwd: normalize(identity.normalizedCwd) });
    const target = this.targets.get(key);
    if (!target || target.kind !== "desktop") return undefined;

    const changed: SessionSummaryPatch = {};
    if (patch.reset && (target.messageCount !== undefined || target.usage !== undefined || target.context !== undefined
      || target.activeSince !== undefined || target.lastActivityAt !== undefined || patch.runtimeStatus !== target.runtimeStatus)) changed.reset = true;
    if (patch.runtimeStatus !== undefined && patch.runtimeStatus !== target.runtimeStatus) changed.runtimeStatus = patch.runtimeStatus;
    if (patch.activeSince !== undefined) {
      const next = patch.activeSince ?? undefined;
      if (next !== target.activeSince) changed.activeSince = patch.activeSince;
    }
    if (patch.lastActivityAt !== undefined && patch.lastActivityAt !== target.lastActivityAt) changed.lastActivityAt = patch.lastActivityAt;
    if (patch.messageCount !== undefined && patch.messageCount !== target.messageCount) changed.messageCount = patch.messageCount;
    if (patch.usage !== undefined && !sameValue(patch.usage, target.usage)) changed.usage = patch.usage;
    if (patch.context !== undefined && !sameValue(patch.context, target.context)) changed.context = patch.context;
    if (Object.keys(changed).length === 0) return undefined;

    this._revision += 1;
    const next: SessionDirectoryTarget = {
      ...target,
      ...(changed.runtimeStatus !== undefined ? { runtimeStatus: changed.runtimeStatus } : {}),
      ...(changed.lastActivityAt !== undefined ? { lastActivityAt: changed.lastActivityAt } : {}),
      ...(changed.messageCount !== undefined ? { messageCount: changed.messageCount } : {}),
      ...(changed.usage !== undefined ? { usage: changed.usage } : {}),
      ...(changed.context !== undefined ? { context: changed.context } : {}),
      summaryRevision: this._revision,
    };
    if (changed.reset) {
      delete next.activeSince;
      delete next.lastActivityAt;
      delete next.messageCount;
      delete next.usage;
      delete next.context;
    }
    if (changed.activeSince === null) delete next.activeSince;
    else if (changed.activeSince !== undefined) next.activeSince = changed.activeSince;
    this.targets.set(key, next);
    return { target: next, patch: changed, revision: this._revision };
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
