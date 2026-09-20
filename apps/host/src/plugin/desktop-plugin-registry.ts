import { normalize } from "node:path";
import type {
  DesktopAskResponse,
  DesktopAskResult,
  DesktopBrokerDeltaMutation,
  DesktopBrokerTargetRecord,
  DesktopPluginCapability,
  DesktopPluginModel,
  DesktopPluginRequest,
  DesktopPluginResult,
  DesktopPluginRuntimeStatus,
  DesktopPluginSessionSummary,
  DesktopPluginTarget,
} from "@maestro-mobile/shared";
import {
  DesktopPluginRegistryStore,
  type DesktopPluginRegistryDiagnosticSnapshot,
} from "./desktop-plugin-registry-store.js";

export interface DesktopPluginTransport {
  request(request: DesktopPluginRequest): Promise<DesktopPluginResult>;
  answerAsk?(response: DesktopAskResponse): Promise<DesktopAskResult>;
  close(): void;
}
export interface DesktopPluginRegistration {
  target: DesktopPluginTarget;
  sessionFile?: string;
  capabilities: readonly DesktopPluginCapability[];
  transport: DesktopPluginTransport;
  model?: DesktopPluginModel;
  thinkingLevel?: string;
  runtimeStatus: DesktopPluginRuntimeStatus;
  summary?: DesktopPluginSessionSummary;
  connectedAt?: string;
  lastEventAt?: string;
}

export interface DesktopPluginRegistryMutation {
  baseRevision: number;
  revision: number;
  mutation: DesktopBrokerDeltaMutation;
}

export interface DesktopPluginRegistryOptions {
  filePath?: string;
  brokerInstanceId?: string;
  store?: DesktopPluginRegistryStore;
}

function keyOf(target: DesktopPluginTarget): string {
  return [target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration].join("\u0000");
}

function normalizeTarget(target: DesktopPluginTarget): DesktopPluginTarget {
  return { ...target, normalizedCwd: normalize(target.normalizedCwd) };
}

function cloneRecord(registration: DesktopPluginRegistration): DesktopBrokerTargetRecord {
  return {
    target: { ...registration.target },
    ...(registration.sessionFile ? { sessionFile: registration.sessionFile } : {}),
    capabilities: [...registration.capabilities],
    ...(registration.model ? { model: { ...registration.model } } : {}),
    ...(registration.thinkingLevel ? { thinkingLevel: registration.thinkingLevel } : {}),
    runtimeStatus: registration.runtimeStatus,
    ...(registration.summary ? { summary: structuredClone(registration.summary) } : {}),
    ...(registration.connectedAt ? { connectedAt: registration.connectedAt } : {}),
    ...(registration.lastEventAt ? { lastEventAt: registration.lastEventAt } : {}),
  };
}

export class DesktopPluginRegistry {
  private readonly registrations = new Map<string, DesktopPluginRegistration>();
  private readonly mutationListeners = new Set<(mutation: DesktopPluginRegistryMutation) => void>();
  private _revision = 0;
  private store?: DesktopPluginRegistryStore;
  private readonly brokerInstanceId: string;

  constructor(options: DesktopPluginRegistryOptions = {}) {
    this.brokerInstanceId = options.brokerInstanceId ?? `broker-${process.pid}`;
    this.store = options.store;
    if (!this.store && options.filePath) {
      this.store = new DesktopPluginRegistryStore({ filePath: options.filePath, brokerInstanceId: this.brokerInstanceId });
    }
  }

  setFilePath(filePath: string): void {
    this.store = new DesktopPluginRegistryStore({ filePath, brokerInstanceId: this.brokerInstanceId });
  }

  get revision(): number {
    return this._revision;
  }

  subscribe(listener: (mutation: DesktopPluginRegistryMutation) => void): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  register(registration: Omit<DesktopPluginRegistration, "runtimeStatus"> & { runtimeStatus?: DesktopPluginRuntimeStatus }): DesktopPluginTarget {
    const target = normalizeTarget(registration.target);
    const key = keyOf(target);
    const previous = this.registrations.get(key);
    if (previous && previous.transport !== registration.transport) previous.transport.close();
    this.registrations.set(key, {
      ...registration,
      target,
      capabilities: [...registration.capabilities],
      runtimeStatus: registration.runtimeStatus ?? "idle",
      connectedAt: registration.connectedAt ?? new Date().toISOString(),
    });
    this.mutate({ kind: "upsert", record: cloneRecord(this.registrations.get(key)!) });
    return target;
  }

  unregister(target: DesktopPluginTarget, expectedTransport?: DesktopPluginTransport): boolean {
    const normalizedTarget = normalizeTarget(target);
    const key = keyOf(normalizedTarget);
    const registration = this.registrations.get(key);
    if (!registration || (expectedTransport && registration.transport !== expectedTransport)) return false;
    this.registrations.delete(key);
    this.mutate({ kind: "remove", target: { ...registration.target } });
    registration.transport.close();
    return true;
  }

  updateModel(target: DesktopPluginTarget, model: DesktopPluginModel): boolean {
    const registration = this.resolve(target);
    if (!registration) return false;
    registration.model = { ...model };
    registration.lastEventAt = new Date().toISOString();
    this.mutate({ kind: "model", target: { ...registration.target }, model: { ...model } });
    return true;
  }

  updateThinkingLevel(target: DesktopPluginTarget, level: string): boolean {
    const registration = this.resolve(target);
    if (!registration) return false;
    registration.thinkingLevel = level;
    registration.lastEventAt = new Date().toISOString();
    this.mutate({ kind: "thinking_level", target: { ...registration.target }, level });
    return true;
  }

  updateRuntimeStatus(target: DesktopPluginTarget, runtimeStatus: DesktopPluginRuntimeStatus): boolean {
    const registration = this.resolve(target);
    if (!registration) return false;
    registration.runtimeStatus = runtimeStatus;
    registration.lastEventAt = new Date().toISOString();
    this.mutate({ kind: "runtime_status", target: { ...registration.target }, runtimeStatus });
    return true;
  }

  updateSessionSummary(target: DesktopPluginTarget, summary: DesktopPluginSessionSummary): boolean {
    const registration = this.resolve(target);
    if (!registration) return false;
    registration.summary = structuredClone(summary);
    registration.runtimeStatus = summary.runtimeStatus;
    registration.lastEventAt = new Date().toISOString();
    this.mutate({ kind: "session_summary", target: { ...registration.target }, summary: { ...summary } });
    return true;
  }

  resolve(target: DesktopPluginTarget): DesktopPluginRegistration | undefined {
    return this.registrations.get(keyOf(normalizeTarget(target)));
  }

  hasCapability(target: DesktopPluginTarget, capability: DesktopPluginCapability): boolean {
    return this.resolve(target)?.capabilities.includes(capability) ?? false;
  }

  list(): DesktopPluginRegistration[] {
    return [...this.registrations.values()].map((registration) => ({
      ...registration,
      target: { ...registration.target },
      capabilities: [...registration.capabilities],
      ...(registration.model ? { model: { ...registration.model } } : {}),
      ...(registration.thinkingLevel ? { thinkingLevel: registration.thinkingLevel } : {}),
      ...(registration.summary ? { summary: structuredClone(registration.summary) } : {}),
    }));
  }

  snapshotRecords(): DesktopBrokerTargetRecord[] {
    return [...this.registrations.values()]
      .sort((left, right) => keyOf(left.target).localeCompare(keyOf(right.target)))
      .map(cloneRecord);
  }

  diagnosticSnapshot(): DesktopPluginRegistryDiagnosticSnapshot {
    return {
      schemaVersion: 1,
      brokerInstanceId: this.brokerInstanceId,
      revision: this._revision,
      registrations: this.snapshotRecords(),
    };
  }

  async flush(): Promise<void> {
    await this.store?.flush(this.diagnosticSnapshot());
  }

  async closeStore(): Promise<void> {
    await this.store?.close();
  }

  clear(): void {
    for (const registration of [...this.registrations.values()]) {
      this.unregister(registration.target, registration.transport);
    }
  }

  private mutate(mutation: DesktopBrokerDeltaMutation): void {
    const baseRevision = this._revision;
    this._revision += 1;
    const change = { baseRevision, revision: this._revision, mutation };
    for (const listener of this.mutationListeners) {
      try {
        listener(change);
      } catch {
        // Listener failures must not prevent persistence of authoritative memory state.
      }
    }
    this.store?.schedule(() => this.diagnosticSnapshot());
  }
}
