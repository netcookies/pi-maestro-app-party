import type { NotificationProvider } from "../notification-types.js";
import { postForm, providerConfig, setting, optionalSetting } from "./helpers.js";

export const pushdeerProvider: NotificationProvider = {
  kind: "pushdeer",
  validate: (config) => providerConfig(config, "pushdeer", ["pushkey"]),
  send: async (event, config, signal) => {
    const endpoint = optionalSetting(config, "endpoint") ?? "https://api2.pushdeer.com";
    const body = new URLSearchParams({ pushkey: setting(config, "pushkey"), text: event.title, desp: event.body });
    return postForm(`${endpoint}/message/push`, body, signal);
  },
  test: async (config, signal) => pushdeerProvider.send({ eventId: "test", kind: "session_error", sessionId: "test", title: "Maestro Mobile test", body: "Notification provider test", occurredAt: new Date().toISOString(), dedupeKey: "test", priority: "normal" }, config, signal),
};
