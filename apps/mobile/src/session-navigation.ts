import { isSessionTargetIdentity, sessionTargetKey, type HostSessionSummary } from "@maestro-mobile/shared";

export interface OpenedSession {
  sessionId: string;
  targetKey: string;
  model?: string;
}

/** Opening a session only selects the exact server-issued target; it performs no Host lifecycle operation. */
export function selectSessionTarget(session: HostSessionSummary): OpenedSession {
  if (!session.target || !isSessionTargetIdentity(session.target)
    || session.target.sessionId !== session.sessionId
    || session.target.endpointId !== session.endpointId) {
    throw new Error("session_target_unavailable");
  }
  const canonicalTargetKey = sessionTargetKey(session.target);
  const modelValue: unknown = session.model;
  const modelStr = typeof modelValue === "string"
    ? modelValue
    : (typeof (modelValue as { id?: unknown } | null | undefined)?.id === "string"
      ? (modelValue as { id: string }).id
      : undefined);
  return {
    sessionId: session.sessionId,
    targetKey: canonicalTargetKey,
    ...(modelStr ? { model: modelStr } : {}),
  };
}

export function routeForOpenedSession(opened: OpenedSession, from: "sessions" | "monitor" = "sessions"): {
  pathname: "/session";
  params: { id: string; targetKey: string; from: "sessions" | "monitor"; model?: string };
} {
  return {
    pathname: "/session",
    params: {
      id: opened.sessionId,
      targetKey: opened.targetKey,
      from,
      ...(opened.model ? { model: opened.model } : {}),
    },
  };
}
