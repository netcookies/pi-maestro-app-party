import {
  isSessionTargetIdentity,
  sessionTargetKey,
  type HostSessionSummary,
  type SessionTargetIdentity,
} from "@maestro-mobile/shared";

export interface OpenedSession {
  sessionId: string;
  targetKey?: string;
}

export interface ResolvedOpenedSession extends OpenedSession {
  target?: SessionTargetIdentity;
}

/** Validate the Host response and retain the exact target generated while opening history. */
export function resolveOpenedSession(
  selected: HostSessionSummary,
  result: unknown,
): ResolvedOpenedSession {
  if (!result || typeof result !== "object") throw new Error("Invalid open session response");
  const value = result as { sessionId?: unknown; target?: unknown };
  if (typeof value.sessionId !== "string" || value.sessionId !== selected.sessionId) {
    throw new Error("Opened session does not match the selected target");
  }

  const returnedTarget = isSessionTargetIdentity(value.target) ? value.target : undefined;
  const target = returnedTarget ?? selected.target;
  if (selected.target && target && sessionTargetKey(selected.target) !== sessionTargetKey(target)) {
    throw new Error("Opened session target does not match the selected endpoint");
  }
  if (selected.target && !target) throw new Error("Opened session response is missing the selected target");

  return {
    sessionId: value.sessionId,
    ...(target ? { target, targetKey: sessionTargetKey(target) } : {}),
  };
}

export function routeForOpenedSession(opened: OpenedSession): {
  pathname: "/session";
  params: { id: string; targetKey?: string };
} {
  return {
    pathname: "/session",
    params: {
      id: opened.sessionId,
      ...(opened.targetKey ? { targetKey: opened.targetKey } : {}),
    },
  };
}
