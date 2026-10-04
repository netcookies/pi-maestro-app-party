import type { DeliveryResult, NotificationEvent, NotificationProvider } from "../notification-types.js";
import { providerConfig, setting, optionalSetting } from "./helpers.js";

async function pushDeerSend(event: NotificationEvent, config: Parameters<NotificationProvider["send"]>[1], signal: AbortSignal): Promise<DeliveryResult> {
  const endpoint = optionalSetting(config, "endpoint") ?? "https://api2.pushdeer.com";
  const body = new URLSearchParams({ pushkey: setting(config, "pushkey"), text: event.title, desp: event.body });
  try {
    const response = await fetch(`${endpoint}/message/push`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    const code = payload && typeof payload === "object" && typeof (payload as { code?: unknown }).code === "number"
      ? (payload as { code: number }).code
      : undefined;
    if (!response.ok) return { ok: false, retryable: response.status >= 500 || response.status === 429, statusCode: response.status, code: `http_${response.status}` };
    if (code !== undefined && code !== 0) return { ok: false, retryable: false, statusCode: response.status, code: `provider_${code}` };
    return { ok: true, retryable: false, statusCode: response.status, code: "sent" };
  } catch (error) {
    return { ok: false, retryable: true, code: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error" };
  }
}

export const pushdeerProvider: NotificationProvider = {
  kind: "pushdeer",
  validate: (config) => providerConfig(config, "pushdeer", ["pushkey"]),
  send: pushDeerSend,
  test: async (config, signal) => pushdeerProvider.send({ eventId: "test", kind: "session_error", sessionId: "test", title: "Maestro Mobile test", body: "Notification provider test", occurredAt: new Date().toISOString(), dedupeKey: "test", priority: "normal" }, config, signal),
};
