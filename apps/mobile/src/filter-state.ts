import type { HostSessionSummary, SessionVisibility } from "@maestro-mobile/shared";

export interface SessionFilter {
  query: string;
  cwd?: string;
  visibility: SessionVisibility;
}

export interface FilterState {
  filter: SessionFilter;
  generation: number;
  cursor?: string;
}

export interface FilterResponseToken {
  generation: number;
  filter: SessionFilter;
  cursor?: string;
}

export function normalizeSessionFilter(input: Partial<SessionFilter> = {}): SessionFilter {
  return {
    query: input.query?.trim() ?? "",
    cwd: input.cwd?.trim() || undefined,
    visibility: input.visibility ?? "session_list",
  };
}

export function createFilterState(filter: Partial<SessionFilter> = {}): FilterState {
  return { filter: normalizeSessionFilter(filter), generation: 0 };
}

/** Every filter change invalidates all in-flight pages and starts at page one. */
export function updateFilterState(state: FilterState, filter: Partial<SessionFilter>): FilterState {
  return { filter: normalizeSessionFilter({ ...state.filter, ...filter }), generation: state.generation + 1 };
}

export function beginFilterRequest(state: FilterState, cursor?: string): FilterResponseToken {
  return { generation: state.generation, filter: state.filter, cursor };
}

export function isFilterResponseCurrent(state: FilterState, token: FilterResponseToken): boolean {
  return state.generation === token.generation
    && state.filter.query === token.filter.query
    && state.filter.cwd === token.filter.cwd
    && state.filter.visibility === token.filter.visibility
    && token.cursor === undefined;
}

export function isPageResponseCurrent(state: FilterState, token: FilterResponseToken, currentCursor?: string): boolean {
  return state.generation === token.generation
    && state.filter.query === token.filter.query
    && state.filter.cwd === token.filter.cwd
    && state.filter.visibility === token.filter.visibility
    && token.cursor === currentCursor;
}

/**
 * Local filtering is deliberately presentation-based: absent server presentation is not
 * assigned a role or visibility by Mobile, so it cannot leak into a scoped list.
 */
export function filterSessionSummaries(
  sessions: readonly HostSessionSummary[],
  filter: Partial<SessionFilter> = {},
): HostSessionSummary[] {
  const normalized = normalizeSessionFilter(filter);
  const query = normalized.query.toLocaleLowerCase();
  return sessions.filter((session) => {
    if (session.presentation?.visibility !== normalized.visibility) return false;
    if (normalized.cwd && session.cwd !== normalized.cwd) return false;
    if (!query) return true;
    return [session.id, session.cwd, session.cwdName, session.title, session.name, session.model]
      .some((value) => value?.toLocaleLowerCase().includes(query));
  });
}
