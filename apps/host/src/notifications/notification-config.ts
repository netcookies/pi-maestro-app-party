import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isNotificationKind,
  isNotificationProviderKind,
  type NotificationConfig,
  type NotificationKind,
  type NotificationProviderConfig,
  type RedactedNotificationProvider,
} from "./notification-types.js";

const EMPTY_CONFIG: NotificationConfig = { schemaVersion: 1, providers: [] };

/** A config error deliberately omits file contents and provider settings. */
export class NotificationConfigError extends Error {
  constructor(message = "notification configuration is invalid or unavailable") {
    super(message);
    this.name = "NotificationConfigError";
  }
}

export class NotificationConfigStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<NotificationConfig> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return cloneConfig(EMPTY_CONFIG);
      throw new NotificationConfigError();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isNotificationConfig(parsed)) throw new Error("schema");
      return cloneConfig(parsed);
    } catch {
      throw new NotificationConfigError();
    }
  }

  async write(config: NotificationConfig): Promise<void> {
    const clean = validateConfig(config);
    await this.enqueueMutation(() => this.writeAtomic(clean));
  }

  /** Add or update one provider while retaining settings omitted by the caller. */
  async upsertProvider(provider: NotificationProviderConfig): Promise<NotificationConfig> {
    return this.mutate((current) => {
      const existing = current.providers.find((entry) => entry.id === provider.id);
      const nextProvider = existing
        ? { ...existing, ...provider, settings: { ...existing.settings, ...provider.settings } }
        : provider;
      const providers = current.providers.filter((entry) => entry.id !== provider.id);
      providers.push(validateProvider(nextProvider));
      return { schemaVersion: 1, providers };
    });
  }

  async updateProvider(id: string, patch: Partial<Omit<NotificationProviderConfig, "id">> & { settings?: Record<string, string | number | boolean> }): Promise<NotificationConfig> {
    return this.mutate((current) => {
      const existing = current.providers.find((entry) => entry.id === id);
      if (!existing) throw new NotificationConfigError("notification provider was not found");
      return {
        schemaVersion: 1,
        providers: current.providers.map((entry) => entry.id === id
          ? validateProvider({ ...entry, ...patch, id, settings: { ...entry.settings, ...(patch.settings ?? {}) } })
          : entry),
      };
    });
  }

  async updateEventKinds(id: string, eventKinds: NotificationKind[]): Promise<NotificationConfig> {
    if (!eventKinds.every(isNotificationKind) || new Set(eventKinds).size !== eventKinds.length) {
      throw new NotificationConfigError("notification event selection is invalid");
    }
    return this.updateProvider(id, { eventKinds });
  }

  async removeProvider(id: string): Promise<NotificationConfig> {
    return this.mutate((current) => ({
      schemaVersion: 1,
      providers: current.providers.filter((provider) => provider.id !== id),
    }));
  }

  /** Backward-compatible full-config patch for the host controller. */
  async patch(patch: Record<string, unknown>): Promise<NotificationConfig> {
    if (!Array.isArray(patch.providers)) return this.read();
    if (!patch.providers.every(isValidProvider)) throw new NotificationConfigError();
    const next = { schemaVersion: 1 as const, providers: patch.providers };
    await this.write(next);
    return next;
  }

  async redacted(): Promise<RedactedNotificationProvider[]> {
    const config = await this.read();
    return config.providers.map(({ id, kind, name, enabled, eventKinds, settings }) => ({
      id, kind, name, enabled, eventKinds, configured: Object.keys(settings).length > 0,
    }));
  }

  private async mutate(mutator: (config: NotificationConfig) => NotificationConfig): Promise<NotificationConfig> {
    let result: NotificationConfig | undefined;
    await this.enqueueMutation(async () => {
      result = validateConfig(mutator(await this.read()));
      await this.writeAtomic(result);
    });
    return result!;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async writeAtomic(config: NotificationConfig): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch {
      await rename(tempPath, `${tempPath}.failed`).catch(() => undefined);
      throw new NotificationConfigError("notification configuration could not be saved");
    }
  }
}

function cloneConfig(config: NotificationConfig): NotificationConfig {
  return { schemaVersion: 1, providers: config.providers.map((provider) => ({ ...provider, eventKinds: [...provider.eventKinds], settings: { ...provider.settings } })) };
}

function validateConfig(config: NotificationConfig): NotificationConfig {
  if (!isNotificationConfig(config)) throw new NotificationConfigError();
  return cloneConfig(config);
}

function isNotificationConfig(value: unknown): value is NotificationConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<NotificationConfig>;
  return config.schemaVersion === 1 && Array.isArray(config.providers)
    && config.providers.every(isValidProvider)
    && new Set(config.providers.map((provider) => provider.id)).size === config.providers.length;
}

function isValidProvider(value: unknown): value is NotificationProviderConfig {
  if (!value || typeof value !== "object") return false;
  try {
    validateProvider(value as NotificationProviderConfig);
    return true;
  } catch {
    return false;
  }
}

function validateProvider(value: NotificationProviderConfig): NotificationProviderConfig {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || value.id.trim().length === 0
    || value.id.length > 200 || !isNotificationProviderKind(value.kind) || typeof value.name !== "string"
    || typeof value.enabled !== "boolean" || !Array.isArray(value.eventKinds)
    || value.eventKinds.some((kind) => !isNotificationKind(kind))
    || new Set(value.eventKinds).size !== value.eventKinds.length || !isSettings(value.settings)) {
    throw new NotificationConfigError();
  }
  return { id: value.id, kind: value.kind, name: value.name, enabled: value.enabled, eventKinds: [...value.eventKinds], settings: { ...value.settings } };
}

function isSettings(value: unknown): value is Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, setting]) => key.length > 0 && key.length <= 200
    && (typeof setting === "string" || typeof setting === "number" || typeof setting === "boolean")
    && !(typeof setting === "number" && !Number.isFinite(setting)));
}
