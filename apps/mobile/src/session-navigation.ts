import { isSessionTargetIdentity, sessionTargetKey, type HostSessionSummary } from "@maestro-mobile/shared";

export interface OpenedSession {
  sessionId: string;
  targetKey: string;
}

/** Opening a session only selects the exact server-issued target; it performs no Host lifecycle operation. */
export function selectSessionTarget(session: HostSessionSummary): OpenedSession {
  if (!session.target || !isSessionTargetIdentity(session.target)
    || session.target.sessionId !== session.sessionId
    || session.target.endpointId !== session.endpointId) {
    throw new Error("session_target_unavailable");
  }
  const canonicalTargetKey = sessionTargetKey(session.target);
  return {
    sessionId: session.sessionId,
    targetKey: canonicalTargetKey,
  };
}

export function routeForOpenedSession(opened: OpenedSession, from: "sessions" | "monitor" = "sessions"): {
  pathname: "/session";
  params: { id: string; targetKey: string; from: "sessions" | "monitor" };
} {
  return {
    pathname: "/session",
    params: { id: opened.sessionId, targetKey: opened.targetKey, from },
  };
}
