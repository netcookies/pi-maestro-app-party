import type { NotificationProvider } from "../notification-types.js";
import { postForm, providerConfig, setting, optionalSetting } from "./helpers.js";

export const ntfyProvider: NotificationProvider = {
  kind: "ntfy",
  validate: (config) => providerConfig(config, "ntfy", ["server", "topic"]),
  send: async (event, config, signal) => {
    const server = optionalSetting(config, "server") ?? "https://ntfy.sh";
    const headers: Record<string, string> = { "X-Title": event.title, "X-Priority": event.priority === "high" ? "high" : "default" };
    const token = optionalSetting(config, "token");
    if (token) headers.Authorization = `Bearer ${token}`;
    return postForm(`${server.replace(/\/$/, "")}/${encodeURIComponent(setting(config, "topic"))}`, new URLSearchParams({ message: event.body }), signal, headers);
  },
  test: async (config, signal) => ntfyProvider.send({ eventId: "test", kind: "session_error", sessionId: "test", title: "Maestro Mobile test", body: "Notification provider test", occurredAt: new Date().toISOString(), dedupeKey: "test", priority: "normal" }, config, signal),
};
