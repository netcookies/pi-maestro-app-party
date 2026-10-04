import type { NotificationProvider } from "../notification-types.js";
import { postJson, providerConfig, setting } from "./helpers.js";

export const telegramProvider: NotificationProvider = {
  kind: "telegram",
  validate: (config) => providerConfig(config, "telegram", ["botToken", "chatId"]),
  send: async (event, config, signal) => postJson(`https://api.telegram.org/bot${encodeURIComponent(setting(config, "botToken"))}/sendMessage`, { chat_id: setting(config, "chatId"), text: `*${event.title}*\n${event.body}`, parse_mode: "Markdown" }, signal),
  test: async (config, signal) => telegramProvider.send({ eventId: "test", kind: "session_error", sessionId: "test", title: "Maestro Mobile test", body: "Notification provider test", occurredAt: new Date().toISOString(), dedupeKey: "test", priority: "normal" }, config, signal),
};
