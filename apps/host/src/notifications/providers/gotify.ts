import type { NotificationProvider } from "../notification-types.js";
import { postJson, providerConfig, setting, urlSetting } from "./helpers.js";

export const gotifyProvider: NotificationProvider = {
  kind: "gotify",
  validate: (config) => providerConfig(config, "gotify", ["server", "token"]),
  send: async (event, config, signal) => {
    const server = urlSetting(config, "server");
    const priority = event.priority === "high" ? 8 : 5;
    return postJson(`${server}/message?token=${encodeURIComponent(setting(config, "token"))}`, { title: event.title, message: event.body, priority }, signal);
  },
  test: async (config, signal) => gotifyProvider.send({ eventId: "test", kind: "session_error", sessionId: "test", title: "Maestro Mobile test", body: "Notification provider test", occurredAt: new Date().toISOString(), dedupeKey: "test", priority: "normal" }, config, signal),
};
