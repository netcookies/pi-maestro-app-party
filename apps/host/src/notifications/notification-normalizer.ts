import type { HostEvent, SessionTargetIdentity } from "@maestro-mobile/shared";
import type { NotificationEvent } from "./notification-types.js";
import { normalizeNotificationEvent } from "./notification-types.js";

export interface NotificationEventContext {
  hostInstanceId: string;
  nextSequence(): number;
}

type SupportedPlanKind = "confirm" | "review" | "generic";

function stableIdentity(value: unknown): string {
  return JSON.stringify(value);
}

function planKind(value: unknown): SupportedPlanKind | undefined {
  return value === "confirm" || value === "review" || value === "generic" ? value : undefined;
}

function planNotificationKind(kind: SupportedPlanKind): NotificationEvent["kind"] {
  return kind === "review" ? "plan_review_pending" : kind === "confirm" ? "plan_confirm_pending" : "plan_pending";
}

export function notificationEventFromHostEvent(event: HostEvent, context: NotificationEventContext): NotificationEvent | undefined {
  if (event.type === "extension_ui_request") {
    const identity = stableIdentity([event.target ?? null, event.request.id, "ask_pending"]);
    const title = event.request.title ?? "桌面会话需要确认";
    const body = event.request.message ?? "请打开 Maestro Mobile 处理待办问题";
    return normalizeNotificationEvent({
      eventId: `ask:${identity}`,
      kind: "ask_pending",
      sessionId: event.sessionId,
      target: event.target,
      requestId: event.request.id,
      title,
      body,
      occurredAt: new Date().toISOString(),
      dedupeKey: `ask:${identity}`,
      priority: "high",
    });
  }
  if (event.type === "desktop_plan_request") {
    if (event.request.deadlineAt <= Date.now()) return undefined;
    const requestKind = planKind((event.request as { kind?: unknown }).kind);
    if (!requestKind) return undefined;
    const kind = planNotificationKind(requestKind);
    const identity = stableIdentity([event.target, event.request.requestId, requestKind]);
    const action = requestKind === "review" ? "评审" : requestKind === "confirm" ? "确认" : "处理";
    return normalizeNotificationEvent({
      eventId: `plan:${identity}`,
      kind,
      sessionId: event.sessionId,
      target: event.target,
      requestId: event.request.requestId,
      deadlineAt: event.request.deadlineAt,
      title: `Plan 等待${action}`,
      body: event.request.pathLabel || `${event.request.mode} Plan 需要您的处理`,
      occurredAt: new Date().toISOString(),
      dedupeKey: `plan:${identity}`,
      priority: "high",
    });
  }
  if (event.type === "session_error") {
    const identity = stableIdentity([event.target ?? null, event.sessionId, event.error.code, event.error.message, "session_error"]);
    return normalizeNotificationEvent({
      eventId: `error:${identity}`,
      kind: "session_error",
      sessionId: event.sessionId,
      target: event.target,
      title: "桌面会话发生错误",
      body: event.error.message,
      occurredAt: new Date().toISOString(),
      dedupeKey: `error:${identity}`,
      priority: "normal",
    });
  }
  return undefined;
}

export function settledNotificationEvent(
  sessionId: string,
  target: SessionTargetIdentity | undefined,
  title: string,
  body: string,
  context: NotificationEventContext,
): NotificationEvent {
  const sequence = context.nextSequence();
  return normalizeNotificationEvent({
    eventId: `${context.hostInstanceId}:${sequence}:agent_settled:${sessionId}`,
    kind: "agent_settled",
    sessionId,
    target,
    title,
    body,
    occurredAt: new Date().toISOString(),
    dedupeKey: `agent_settled:${sessionId}:${target ? JSON.stringify(target) : ""}:${sequence}`,
    priority: "normal",
  });
}
