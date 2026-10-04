import type { SessionTargetIdentity } from "@maestro-mobile/shared";

export type NotificationKind = "ask_pending" | "plan_pending" | "plan_review_pending" | "plan_confirm_pending" | "agent_settled" | "session_error";
export type NotificationPriority = "normal" | "high";
export type NotificationDeliveryStatus = "pending" | "sending" | "sent" | "failed" | "expired";

export interface NotificationEvent {
  eventId: string;
  kind: NotificationKind;
  sessionId: string;
  target?: SessionTargetIdentity;
  requestId?: string;
  deadlineAt?: number;
  title: string;
  body: string;
  occurredAt: string;
  dedupeKey: string;
  priority: NotificationPriority;
  deepLink?: string;
}

export interface NotificationOutboxEntry {
  event: NotificationEvent;
  status: NotificationDeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastErrorCode?: string;
  providerResults?: Record<string, DeliveryResult>;
}

export type NotificationProviderKind = "pushdeer" | "ntfy" | "bark" | "gotify" | "telegram" | "webhook";

export interface ProviderConfigBase {
  id: string;
  kind: NotificationProviderKind;
  name: string;
  enabled: boolean;
  eventKinds: NotificationKind[];
}

export interface NotificationProviderConfig extends ProviderConfigBase {
  settings: Record<string, string | number | boolean>;
}

export interface RedactedNotificationProvider {
  id: string;
  kind: NotificationProviderKind;
  name: string;
  enabled: boolean;
  eventKinds: NotificationKind[];
  configured: boolean;
  lastDeliveryStatus?: NotificationDeliveryStatus;
  lastErrorCode?: string;
}

export interface NotificationConfig {
  schemaVersion: 1;
  providers: NotificationProviderConfig[];
}

export interface DeliveryResult {
  ok: boolean;
  retryable: boolean;
  statusCode?: number;
  code: string;
}

export interface NotificationProvider {
  readonly kind: NotificationProviderKind;
  validate(config: unknown): NotificationProviderConfig;
  send(event: NotificationEvent, config: NotificationProviderConfig, signal: AbortSignal): Promise<DeliveryResult>;
  test(config: NotificationProviderConfig, signal: AbortSignal): Promise<DeliveryResult>;
}

export const NOTIFICATION_MAX_TITLE_LENGTH = 160;
export const NOTIFICATION_MAX_BODY_LENGTH = 4000;
export const NOTIFICATION_MAX_OUTBOX_ENTRIES = 512;
export const NOTIFICATION_MAX_ATTEMPTS = 8;

export function sanitizeNotificationText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, maxLength);
}

function sanitizeNotificationIdentity(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
}

export function normalizeNotificationEvent(event: NotificationEvent): NotificationEvent {
  return {
    ...event,
    eventId: sanitizeNotificationIdentity(event.eventId),
    sessionId: sanitizeNotificationIdentity(event.sessionId),
    ...(event.requestId === undefined ? {} : { requestId: sanitizeNotificationIdentity(event.requestId) }),
    title: sanitizeNotificationText(event.title, NOTIFICATION_MAX_TITLE_LENGTH),
    body: sanitizeNotificationText(event.body, NOTIFICATION_MAX_BODY_LENGTH),
    occurredAt: sanitizeNotificationIdentity(event.occurredAt),
    dedupeKey: sanitizeNotificationIdentity(event.dedupeKey),
  };
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return value === "ask_pending" || value === "plan_pending" || value === "plan_review_pending" || value === "plan_confirm_pending" || value === "agent_settled" || value === "session_error";
}

export function isNotificationProviderKind(value: unknown): value is NotificationProviderKind {
  return value === "pushdeer" || value === "ntfy" || value === "bark" || value === "gotify" || value === "telegram" || value === "webhook";
}
