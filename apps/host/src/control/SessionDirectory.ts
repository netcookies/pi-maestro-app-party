import { normalize } from "node:path";
import type { SessionContextUsage, SessionPresentation, SessionRuntimeStatus, SessionSummaryPatch, SessionTargetIdentity, SessionUsageTotals } from "@maestro-mobile/shared";
import type { DesktopPluginCapability, DesktopPluginModel, DesktopPluginRuntimeStatus, DesktopPluginTarget } from "@maestro-mobile/shared";

export type { SessionTargetIdentity } from "@maestro-mobile/shared";

export type SessionControlCapability = "prompt" | "steer" | "follow_up" | "abort" | "set_model" | "set_thinking" | "ask" | "plan";

export interface SessionDirectoryTarget {
  identity: SessionTargetIdentity;
  kind: "desktop" | "history";
  capabilities: readonly SessionControlCapability[];
  /** Reader metadata supplied by the exact Desktop runtime; not part of identity. */
  sessionFile?: string;
  model?: DesktopPluginModel;
  thinkingLevel?: string;
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
      mode: kind === "desktop" ? "desktop_plugin" : "readonly",
      canPrompt: available.has("prompt"),
      canSteer: available.has("steer"),
      canFollowUp: available.has("follow_up"),
      canAbort: available.has("abort"),
      canAnswerAsk: available.has("ask"),
      canPlan: available.has("plan"),
    },
    revision,
  };
}

export class SessionDirectory {
  private readonly targets = new Map<string, SessionDirectoryTarget>();
  private _revision = 0;

  get revision(): number {
    return this._revision;
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
      } else if (capability === "plan") {
        controlCapabilities.push("plan");
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
      ...(metadata.sessionFile !== undefined ? { sessionFile: metadata.sessionFile } : existing?.sessionFile ? { sessionFile: existing.sessionFile } : {}),
      model: metadata.model ? { ...metadata.model } : existing?.model,
      thinkingLevel: metadata.thinkingLevel ?? existing?.thinkingLevel,
      runtimeStatus: existing?.runtimeStatus ?? "idle",
    });
    return identity;
  }

  registerHistoryTarget(identity: SessionTargetIdentity, sessionFile: string): SessionTargetIdentity {
    this.register({
      identity: { ...identity, normalizedCwd: normalize(identity.normalizedCwd) },
      kind: "history",
      capabilities: [],
      sessionFile,
      runtimeStatus: "history",
      presentation: presentationForTarget("history", [], this._revision + 1),
    });
    return identity;
  }

  updateDesktopModel(identity: SessionTargetIdentity, model?: DesktopPluginModel): boolean {
    const target = this.resolve(identity);
    if (!target || target.kind !== "desktop") return false;
    if (sameValue(target.model, model)) return true;
    const next = { ...target };
    if (model === undefined) delete next.model;
    else next.model = { ...model };
    this.register(next);
    return true;
  }

  updateDesktopThinking(identity: SessionTargetIdentity, level: string | undefined): boolean {
    const target = this.resolve(identity);
    if (!target || target.kind !== "desktop") return false;
    if (target.thinkingLevel === level) return true;
    const next = { ...target };
    if (level === undefined) delete next.thinkingLevel;
    else next.thinkingLevel = level;
    this.register(next);
    return true;
  }

  clearDesktopSummary(identity: SessionTargetIdentity, runtimeStatus: DesktopPluginRuntimeStatus): boolean {
    const target = this.resolve(identity);
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
    const target = this.resolve(identity);
    if (!target || target.kind !== "desktop") return undefined;
    const changed: SessionSummaryPatch = {};
    if (patch.reset && (target.messageCount !== undefined || target.usage !== undefined || target.context !== undefined
      || target.activeSince !== undefined || target.lastActivityAt !== undefined || patch.runtimeStatus !== target.runtimeStatus)) changed.reset = true;
    if (patch.runtimeStatus !== undefined && patch.runtimeStatus !== target.runtimeStatus) changed.runtimeStatus = patch.runtimeStatus;
    if (patch.activeSince !== undefined && patch.activeSince !== (target.activeSince ?? null)) changed.activeSince = patch.activeSince;
    if (patch.lastActivityAt !== undefined && patch.lastActivityAt !== target.lastActivityAt) changed.lastActivityAt = patch.lastActivityAt;
    if (patch.messageCount !== undefined && patch.messageCount !== target.messageCount) changed.messageCount = patch.messageCount;
    if (patch.usage !== undefined && !sameValue(patch.usage, target.usage)) changed.usage = patch.usage;
    if (patch.context !== undefined && !sameValue(patch.context, target.context)) changed.context = patch.context;
    if (Object.keys(changed).length === 0) return undefined;

    this._revision += 1;
    const next: SessionDirectoryTarget = { ...target, summaryRevision: this._revision };
    if (changed.runtimeStatus !== undefined) next.runtimeStatus = changed.runtimeStatus;
    if (changed.lastActivityAt !== undefined) next.lastActivityAt = changed.lastActivityAt;
    if (changed.messageCount !== undefined) next.messageCount = changed.messageCount;
    if (changed.usage !== undefined) next.usage = changed.usage;
    if (changed.context !== undefined) next.context = changed.context;
    if (changed.reset) {
      delete next.activeSince;
      delete next.lastActivityAt;
      delete next.messageCount;
      delete next.usage;
      delete next.context;
    }
    if (changed.activeSince === null) delete next.activeSince;
    else if (changed.activeSince !== undefined) next.activeSince = changed.activeSince;
    this.targets.set(keyOf(next.identity), next);
    return { target: next, patch: changed, revision: this._revision };
  }

  register(target: SessionDirectoryTarget): void {
    const normalizedIdentity = { ...target.identity, normalizedCwd: normalize(target.identity.normalizedCwd) };
    const capabilities = [...target.capabilities];
    const presentation = target.presentation ?? presentationForTarget(target.kind, capabilities, this._revision + 1);
    this.targets.set(keyOf(normalizedIdentity), {
      ...target,
      identity: normalizedIdentity,
      capabilities,
      presentation,
    });
    this._revision += 1;
  }

  unregister(identity: SessionTargetIdentity): boolean {
    const removed = this.targets.delete(keyOf({ ...identity, normalizedCwd: normalize(identity.normalizedCwd) }));
    if (removed) this._revision += 1;
    return removed;
  }

  resolve(identity: SessionTargetIdentity, capability?: SessionControlCapability): SessionDirectoryTarget | undefined {
    const target = this.targets.get(keyOf({ ...identity, normalizedCwd: normalize(identity.normalizedCwd) }));
    if (!target) return undefined;
    if (capability && !target.capabilities.includes(capability)) return undefined;
    return target;
  }

  list(): SessionDirectoryTarget[] {
    return [...this.targets.values()].map((target) => ({ ...target, capabilities: [...target.capabilities] }));
  }
}
