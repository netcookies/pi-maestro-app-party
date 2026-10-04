import type { NotificationProvider } from "../notification-types.js";
import { postForm, providerConfig, setting, optionalSetting } from "./helpers.js";

export const barkProvider: NotificationProvider = {
  kind: "bark",
  validate: (config) => providerConfig(config, "bark", ["server", "deviceKey"]),
  send: async (event, config, signal) => {
    const server = optionalSetting(config, "server") ?? "https://api.day.app";
    const body = new URLSearchParams({ title: event.title, body: event.body, sound: optionalSetting(config, "sound") ?? "birdsong" });
    return postForm(`${server.replace(/\/$/, "")}/${encodeURIComponent(setting(config, "deviceKey"))}`, body, signal);
  },
  test: async (config, signal) => barkProvider.send({ eventId: "test", kind: "session_error", sessionId: "test", title: "Maestro Mobile test", body: "Notification provider test", occurredAt: new Date().toISOString(), dedupeKey: "test", priority: "normal" }, config, signal),
};
