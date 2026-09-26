import { isSessionTargetIdentity, sessionTargetKey, type HostSessionSummary } from "@maestro-mobile/shared";

export interface OpenedSession {
  sessionId: string;
  targetKey: string;
}

/** Opening a session only selects the exact server-issued target; it performs no Host lifecycle operation. */
export function selectSessionTarget(session: HostSessionSummary): OpenedSession {
  if (!session.target || !isSessionTargetIdentity(session.target)) {
    throw new Error("session_target_unavailable");
  }
  return {
    sessionId: session.sessionId,
    targetKey: session.targetKey ?? sessionTargetKey(session.target),
  };
}

export function routeForOpenedSession(opened: OpenedSession): {
  pathname: "/session";
  params: { id: string; targetKey: string };
} {
  return {
    pathname: "/session",
    params: { id: opened.sessionId, targetKey: opened.targetKey },
  };
}
