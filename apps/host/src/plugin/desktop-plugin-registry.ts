import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";
import type {
  DesktopPluginCapability,
  DesktopAskResponse,
  DesktopPluginRequest,
  DesktopPluginResult,
  DesktopPluginTarget,
} from "@maestro-mobile/shared";

export interface DesktopPluginTransport {
  request(request: DesktopPluginRequest): Promise<DesktopPluginResult>;
  answerAsk?(response: DesktopAskResponse): void;
  close(): void;
}

export interface DesktopPluginRegistration {
  target: DesktopPluginTarget;
  capabilities: readonly DesktopPluginCapability[];
  transport: DesktopPluginTransport;
}

function keyOf(target: DesktopPluginTarget): string {
  return [target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration].join("\u0000");
}

export interface DesktopPluginRegistryOptions {
  filePath?: string;
}

export class DesktopPluginRegistry {
  private readonly registrations = new Map<string, DesktopPluginRegistration>();
  private _revision = 0;
  private filePath?: string;

  constructor(options: DesktopPluginRegistryOptions = {}) {
    this.filePath = options.filePath;
  }

  setFilePath(filePath: string): void {
    this.filePath = filePath;
  }

  get revision(): number {
    return this._revision;
  }

  register(registration: DesktopPluginRegistration): DesktopPluginTarget {
    const target = { ...registration.target, normalizedCwd: normalize(registration.target.normalizedCwd) };
    const key = keyOf(target);
    const previous = this.registrations.get(key);
    if (previous && previous.transport !== registration.transport) previous.transport.close();
    this.registrations.set(key, {
      ...registration,
      target,
      capabilities: [...registration.capabilities],
    });
    this._revision += 1;
    return target;
  }

  unregister(target: DesktopPluginTarget, expectedTransport?: DesktopPluginTransport): boolean {
    const key = keyOf({ ...target, normalizedCwd: normalize(target.normalizedCwd) });
    const registration = this.registrations.get(key);
    if (!registration || (expectedTransport && registration.transport !== expectedTransport)) return false;
    this.registrations.delete(key);
    this._revision += 1;
    registration.transport.close();
    return true;
  }

  resolve(target: DesktopPluginTarget): DesktopPluginRegistration | undefined {
    return this.registrations.get(keyOf({ ...target, normalizedCwd: normalize(target.normalizedCwd) }));
  }

  hasCapability(target: DesktopPluginTarget, capability: DesktopPluginCapability): boolean {
    return this.resolve(target)?.capabilities.includes(capability) ?? false;
  }

  list(): DesktopPluginRegistration[] {
    return [...this.registrations.values()].map((registration) => ({
      ...registration,
      target: { ...registration.target },
      capabilities: [...registration.capabilities],
    }));
  }

  async flush(): Promise<void> {
    if (!this.filePath) return;
    const path = this.filePath;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ revision: this._revision, registrations: this.list().map((registration) => ({ target: registration.target, capabilities: registration.capabilities })) }), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }

  clear(): void {
    for (const registration of this.registrations.values()) registration.transport.close();
    if (this.registrations.size > 0) this._revision += 1;
    this.registrations.clear();
  }
}
