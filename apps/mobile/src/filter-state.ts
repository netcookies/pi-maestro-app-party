import type { HostSessionSummary, SessionVisibility } from "@maestro-mobile/shared";

export interface SessionFilter {
  query: string;
  /** 项目 cwd 多选；空/undefined 表示不过滤 */
  cwds?: string[];
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
  const cwds = input.cwds?.filter((cwd) => typeof cwd === "string" && cwd.trim()).map((cwd) => cwd.trim());
  return {
    query: input.query?.trim() ?? "",
    ...(cwds && cwds.length > 0 ? { cwds } : {}),
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
  return state.generation === token.generation && sameFilter(state.filter, token.filter) && token.cursor === undefined;
}

export function isPageResponseCurrent(state: FilterState, token: FilterResponseToken, currentCursor?: string): boolean {
  return state.generation === token.generation && sameFilter(state.filter, token.filter) && token.cursor === currentCursor;
}

function sameFilter(a: SessionFilter, b: SessionFilter): boolean {
  return a.query === b.query && a.visibility === b.visibility
    && (a.cwds ?? []).join("\u0000") === (b.cwds ?? []).join("\u0000");
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
    if (normalized.cwds && !normalized.cwds.includes(session.cwd)) return false;
    if (!query) return true;
    return [session.id, session.cwd, session.cwdName, session.title, session.name, session.model]
      .some((value) => value?.toLocaleLowerCase().includes(query));
  });
}
