import type { NotificationProvider, NotificationProviderKind } from "../notification-types.js";
import { barkProvider } from "./bark.js";
import { gotifyProvider } from "./gotify.js";
import { ntfyProvider } from "./ntfy.js";
import { pushdeerProvider } from "./pushdeer.js";
import { telegramProvider } from "./telegram.js";
import { webhookProvider } from "./webhook.js";

export const notificationProviders = new Map<NotificationProviderKind, NotificationProvider>([
  ["pushdeer", pushdeerProvider],
  ["ntfy", ntfyProvider],
  ["bark", barkProvider],
  ["gotify", gotifyProvider],
  ["telegram", telegramProvider],
  ["webhook", webhookProvider],
]);

export function getNotificationProvider(kind: NotificationProviderKind): NotificationProvider | undefined {
  return notificationProviders.get(kind);
}
