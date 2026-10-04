import type { NotificationProvider } from "../notification-types.js";
import { postJson, providerConfig, urlSetting } from "./helpers.js";

const ALLOWED_HEADERS = new Set(["content-type", "authorization", "x-api-key", "x-signature"]);

export const webhookProvider: NotificationProvider = {
  kind: "webhook",
  validate: (config) => providerConfig(config, "webhook", ["url"]),
  send: async (event, config, signal) => {
    const headers: Record<string, string> = {};
    const rawHeaders = config.settings.headers;
    if (typeof rawHeaders === "string") {
      try {
        const parsed = JSON.parse(rawHeaders) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (ALLOWED_HEADERS.has(key.toLowerCase()) && typeof value === "string") headers[key.toLowerCase()] = value;
        }
      } catch {
        return { ok: false, retryable: false, code: "invalid_headers" };
      }
    }
    return postJson(urlSetting(config, "url", true), event, signal, headers);
  },
  test: async (config, signal) => webhookProvider.send({ eventId: "test", kind: "session_error", sessionId: "test", title: "Maestro Mobile test", body: "Notification provider test", occurredAt: new Date().toISOString(), dedupeKey: "test", priority: "normal" }, config, signal),
};
