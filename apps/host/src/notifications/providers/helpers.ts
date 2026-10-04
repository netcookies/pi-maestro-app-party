import type {
  DeliveryResult,
  NotificationEvent,
  NotificationProvider,
  NotificationProviderConfig,
} from "../notification-types.js";

export function setting(config: NotificationProviderConfig, key: string): string {
  const value = config.settings[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`missing_${key}`);
  return value.trim();
}

export function optionalSetting(config: NotificationProviderConfig, key: string): string | undefined {
  const value = config.settings[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function urlSetting(config: NotificationProviderConfig, key: string, allowHttp = false): string {
  const raw = setting(config, key);
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw new Error(`${key}_must_use_https`);
  return url.toString().replace(/\/$/, "");
}

export function providerConfig(config: unknown, kind: NotificationProviderConfig["kind"], required: string[]): NotificationProviderConfig {
  if (!config || typeof config !== "object") throw new Error("invalid_provider_config");
  const value = config as Partial<NotificationProviderConfig>;
  if (value.kind !== kind || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.enabled !== "boolean" || !Array.isArray(value.eventKinds) || !value.settings || typeof value.settings !== "object") throw new Error("invalid_provider_config");
  for (const key of required) setting(value as NotificationProviderConfig, key);
  return value as NotificationProviderConfig;
}

export async function postJson(url: string, payload: unknown, signal: AbortSignal, headers: Record<string, string> = {}): Promise<DeliveryResult> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), signal });
    return { ok: response.ok, retryable: response.status >= 500 || response.status === 429, statusCode: response.status, code: response.ok ? "sent" : `http_${response.status}` };
  } catch (error) {
    return { ok: false, retryable: true, code: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error" };
  }
}

export async function postForm(url: string, body: URLSearchParams, signal: AbortSignal, headers: Record<string, string> = {}): Promise<DeliveryResult> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body, signal });
    return { ok: response.ok, retryable: response.status >= 500 || response.status === 429, statusCode: response.status, code: response.ok ? "sent" : `http_${response.status}` };
  } catch (error) {
    return { ok: false, retryable: true, code: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error" };
  }
}

export function textPayload(event: NotificationEvent): { title: string; body: string } {
  return { title: event.title, body: event.body };
}

export function testEvent(kind: NotificationEvent["kind"] = "session_error"): NotificationEvent {
  return { eventId: `test-${Date.now()}`, kind, sessionId: "test", title: "Maestro Mobile test", body: "Notification provider test", occurredAt: new Date().toISOString(), dedupeKey: `test-${Date.now()}`, priority: "normal" };
}

export function validateWith(provider: NotificationProvider, config: unknown): NotificationProviderConfig {
  return provider.validate(config);
}
