import type { DesktopBrokerTargetRecord } from "@maestro-mobile/shared";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export const DESKTOP_PLUGIN_REGISTRY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_DESKTOP_PLUGIN_REGISTRY_DEBOUNCE_MS = 35;

export interface DesktopPluginRegistryDiagnosticSnapshot {
  schemaVersion: typeof DESKTOP_PLUGIN_REGISTRY_SCHEMA_VERSION;
  brokerInstanceId: string;
  revision: number;
  registrations: readonly DesktopBrokerTargetRecord[];
}

export type DesktopPluginRegistrySnapshotSupplier = () => DesktopPluginRegistryDiagnosticSnapshot;

export interface DesktopPluginRegistryStoreOptions {
  filePath: string;
  brokerInstanceId: string;
  debounceMs?: number;
}

/** Serializes diagnostic snapshots; this file is never used to restore live transports. */
export class DesktopPluginRegistryStore {
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: DesktopPluginRegistryDiagnosticSnapshot | DesktopPluginRegistrySnapshotSupplier | undefined;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: DesktopPluginRegistryStoreOptions) {
    if (!options.filePath) throw new Error("desktop plugin registry path is required");
    if (!options.brokerInstanceId) throw new Error("desktop broker instance id is required");
    this.debounceMs = options.debounceMs ?? DEFAULT_DESKTOP_PLUGIN_REGISTRY_DEBOUNCE_MS;
  }

  schedule(snapshot: DesktopPluginRegistryDiagnosticSnapshot | DesktopPluginRegistrySnapshotSupplier): void {
    if (this.closed) return;
    this.latest = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch(() => undefined);
    }, this.debounceMs);
  }

  async flush(snapshot?: DesktopPluginRegistryDiagnosticSnapshot): Promise<void> {
    if (this.closed) return;
    if (snapshot) this.latest = snapshot;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.drain();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.writing;
  }

  private async drain(): Promise<void> {
    const pending = this.latest;
    const snapshot = typeof pending === "function" ? pending() : pending;
    this.latest = undefined;
    if (!snapshot) return;
    this.writing = this.writing.catch(() => undefined).then(() => this.write(snapshot));
    await this.writing;
    if (this.latest && !this.closed) await this.drain();
  }

  private async write(snapshot: DesktopPluginRegistryDiagnosticSnapshot): Promise<void> {
    const path = this.options.filePath;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => undefined);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify({
      schemaVersion: DESKTOP_PLUGIN_REGISTRY_SCHEMA_VERSION,
      brokerInstanceId: this.options.brokerInstanceId,
      revision: snapshot.revision,
      registrations: snapshot.registrations,
    })}\n`;
    await writeFile(temporary, payload, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }
}
