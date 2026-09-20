import type { DesktopPluginRuntimeStatus, DesktopPluginSessionSummary, DesktopPluginTarget } from "@maestro-mobile/shared";

export const DESKTOP_PLUGIN_RUNTIME_STATE_KEY = Symbol.for("maestro-mobile.desktop-plugin-runtime-state.v1");

export type DesktopPluginBrokerHealth = "connected" | "disconnected" | "unknown";

export interface DesktopPluginRuntimeRecord {
  target: DesktopPluginTarget;
  localStatus: DesktopPluginRuntimeStatus;
  pluginBroker: DesktopPluginBrokerHealth;
  transitionAt: string;
  lastError?: string;
  generationToken: string;
  summary?: DesktopPluginSessionSummary;
}

interface RuntimeStateGlobal {
  record?: DesktopPluginRuntimeRecord;
}

type RuntimeGlobal = typeof globalThis & { [DESKTOP_PLUGIN_RUNTIME_STATE_KEY]?: RuntimeStateGlobal };

function state(): RuntimeStateGlobal {
  const global = globalThis as RuntimeGlobal;
  return global[DESKTOP_PLUGIN_RUNTIME_STATE_KEY] ??= {};
}

function sanitizeError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  const value = error instanceof Error ? error.message : String(error);
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

export function beginDesktopPluginRuntimeRecord(record: DesktopPluginRuntimeRecord): void {
  state().record = structuredClone(record);
}

export function updateDesktopPluginRuntimeRecord(
  generationToken: string,
  patch: Omit<Partial<DesktopPluginRuntimeRecord>, "target" | "generationToken" | "transitionAt"> & { error?: unknown },
): void {
  const current = state().record;
  if (!current || current.generationToken !== generationToken) return;
  const next: DesktopPluginRuntimeRecord = {
    ...current,
    ...patch,
    transitionAt: new Date().toISOString(),
    ...(patch.error !== undefined ? { lastError: sanitizeError(patch.error) } : {}),
  };
  delete (next as { error?: unknown }).error;
  state().record = structuredClone(next);
}

export function clearDesktopPluginRuntimeRecord(generationToken: string): void {
  const current = state().record;
  if (current?.generationToken === generationToken) delete state().record;
}

export function getDesktopPluginRuntimeRecord(): DesktopPluginRuntimeRecord | undefined {
  const current = state().record;
  return current ? structuredClone(current) : undefined;
}

export function sanitizeDesktopPluginRuntimeError(error: unknown): string | undefined {
  return sanitizeError(error);
}
