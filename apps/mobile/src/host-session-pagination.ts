import { sessionTargetKey, type HostSessionList, type HostSessionSummary, type SessionPresentation, type SessionSummaryPatch, type SessionTargetIdentity, type SessionVisibility } from "@maestro-mobile/shared";

export function isServerSessionPresentation(value: unknown): value is SessionPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const c = p.control;
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const control = c as Record<string, unknown>;
  return (p.role === "session" || p.role === "monitor")
    && (p.visibility === "session_list" || p.visibility === "monitor_tab" || p.visibility === "hidden")
    && typeof p.revision === "number" && Number.isFinite(p.revision)
    && (control.mode === "host" || control.mode === "desktop_plugin" || control.mode === "readonly")
    && typeof control.canPrompt === "boolean" && typeof control.canSteer === "boolean"
    && typeof control.canFollowUp === "boolean" && typeof control.canAbort === "boolean"
    && typeof control.canAnswerAsk === "boolean";
}

export function filterSessionsByVisibility(
  sessions: readonly HostSessionSummary[],
  visibility: SessionVisibility,
): HostSessionSummary[] {
  return sessions.filter((session) => session.presentation?.visibility === visibility);
}

/** Current shows a known runtime in the Sessions list, including readonly sleeping telemetry. */
export function isCurrentSessionSummary(session: HostSessionSummary): boolean {
  return session.runtimeStatus !== "history" && session.presentation?.visibility === "session_list";
}

export interface HostSessionPageState {
  sessions: HostSessionSummary[];
  nextCursor?: string;
  hasMore: boolean;
  total?: number;
  revision?: number;
}

export function mergeSessionPresentation<T extends { presentation?: SessionPresentation }>(
  current: T | undefined,
  incoming: T,
): T {
  const currentRevision = current?.presentation?.revision;
  const incomingRevision = incoming.presentation?.revision;
  if (current && currentRevision !== undefined && incomingRevision !== undefined && incomingRevision < currentRevision) {
    return current;
  }
  return incoming.presentation && isServerSessionPresentation(incoming.presentation)
    ? incoming
    : current ? { ...incoming, presentation: current.presentation } : incoming;
}

export type TargetedCapability = "unknown" | "supported" | "unsupported";

export function shouldRequestTargetedSummaries(input: {
  capability: TargetedCapability;
  inFlight: boolean;
  failureCount: number;
  maxFailures: number;
  retryAt: number;
  now: number;
}): boolean {
  return input.capability !== "unsupported"
    && !input.inFlight
    && input.failureCount < input.maxFailures
    && input.now >= input.retryAt;
}

export function isTargetedResponseCurrent(input: {
  expectedGeneration: number;
  currentGeneration: number;
  expectedHostIdentity: string;
  currentHostIdentity: string;
  connected: boolean;
}): boolean {
  return input.connected
    && input.expectedGeneration === input.currentGeneration
    && input.expectedHostIdentity === input.currentHostIdentity;
}

export function canLoadMoreSessions(input: {
  connected: boolean;
  hasMore: boolean;
  nextCursor?: string;
  loading: boolean;
  lastRequestedCursor?: string;
  firstPageInFlight?: boolean;
}): boolean {
  return input.connected
    && input.hasMore
    && Boolean(input.nextCursor)
    && !input.loading
    && !input.firstPageInFlight
    && input.lastRequestedCursor !== input.nextCursor;
}

export function mergeHostSessionPage(
  current: HostSessionSummary[],
  response: HostSessionList,
  reset: boolean,
): HostSessionPageState {
  const merged = reset ? [] : [...current];
  const indexes = new Map(merged.map((session, index) => [session.targetKey ?? session.id, index]));

  for (const session of response.sessions) {
    const key = session.targetKey ?? session.id;
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, merged.length);
      merged.push(session);
    } else {
      merged[index] = session;
    }
  }

  // Older Hosts omit every pagination field and have already returned the full list.
  const paginated = typeof response.hasMore === "boolean";
  const nextCursor = paginated && response.hasMore && response.nextCursor
    ? response.nextCursor
    : undefined;

  return {
    sessions: merged,
    nextCursor,
    hasMore: Boolean(nextCursor),
    total: paginated ? response.total : undefined,
    revision: merged.reduce((max, session) => Math.max(max, session.presentation?.revision ?? 0), 0) || undefined,
  };
}

export function patchHostSessionSummary(
  current: readonly HostSessionSummary[],
  target: SessionTargetIdentity,
  patch: SessionSummaryPatch,
  revision: number,
): HostSessionSummary[] {
  const key = sessionTargetKey(target);
  return current.map((session) => {
    // Event targets are exact identities. A legacy row without target metadata cannot
    // safely accept a patch from a different endpoint sharing the same sessionId.
    if (session.targetKey !== key) return session;
    if ((session.summaryRevision ?? 0) >= revision) return session;
    const usage = patch.usage;
    // Reset is a boundary for the target's live projection. Remove fields that may
    // have been merged by an earlier runtime before applying any values in this patch.
    const base = patch.reset
      ? (({ activeSince: _activeSince, lastActivityAt: _lastActivityAt, messageCount: _messageCount,
          usage: _usage, totalTokens: _totalTokens, cost: _cost, context: _context, ...withoutStale } = session) => withoutStale)(session)
      : session;
    return {
      ...base,
      ...(patch.runtimeStatus !== undefined ? { runtimeStatus: patch.runtimeStatus } : {}),
      ...(patch.activeSince !== undefined ? (patch.activeSince === null ? { activeSince: undefined } : { activeSince: patch.activeSince }) : {}),
      ...(patch.lastActivityAt !== undefined ? { lastActivityAt: patch.lastActivityAt, updatedAt: patch.lastActivityAt } : {}),
      ...(patch.messageCount !== undefined ? { messageCount: patch.messageCount } : {}),
      ...(usage !== undefined ? { usage, totalTokens: usage.totalTokens, cost: usage.cost } : {}),
      ...(patch.context !== undefined ? { context: patch.context } : {}),
      summaryRevision: revision,
    } as HostSessionSummary;
  });
}

export function mergeTargetedHostSessions(
  current: HostSessionPageState,
  response: HostSessionList,
): HostSessionPageState {
  if (response.targeted !== true) return current;
  const merged = mergeHostSessionPage(current.sessions, response, false);
  return { ...current, sessions: merged.sessions };
}

export function shouldBlockSessionListError(sessionCount: number): boolean {
  return sessionCount === 0;
}

export function isLoadMoreResponseCurrent(input: {
  expectedGeneration: number;
  currentGeneration: number;
  expectedQuery: string;
  currentQuery: string;
  expectedCursor: string;
  currentCursor?: string;
}): boolean {
  return input.expectedGeneration === input.currentGeneration
    && input.expectedQuery === input.currentQuery
    && input.expectedCursor === input.currentCursor;
}
