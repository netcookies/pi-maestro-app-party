import type { HostSessionList, HostSessionSummary } from "@maestro-mobile/shared";

export interface HostSessionPageState {
  sessions: HostSessionSummary[];
  nextCursor?: string;
  hasMore: boolean;
  total?: number;
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
  const indexes = new Map(merged.map((session, index) => [session.id, index]));

  for (const session of response.sessions) {
    const index = indexes.get(session.id);
    if (index === undefined) {
      indexes.set(session.id, merged.length);
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
  };
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
