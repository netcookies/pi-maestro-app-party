export const TAB_COUNT = 4;

export type TabParam = string | string[] | undefined;

export interface NavigationRouteLike {
  key?: string;
  name?: string;
  params?: object;
  state?: NavigationStateLike;
}

export interface NavigationStateLike {
  index?: number;
  routes?: readonly NavigationRouteLike[];
}

export interface TabsNavigationIdentity {
  isTabsRootFocused: boolean;
  rootKey: string | null;
  focusedKey: string | null;
  pathname: string;
  tab: string | null;
}

export interface TabsEntrySnapshot extends TabsNavigationIdentity {}

export function getIndexFromPathname(path: string): number | null {
  if (path.includes("settings")) return 3;
  if (path.includes("monitor")) return 2;
  if (path.includes("host-sessions") || path.includes("sessions")) return 0;
  if (path === "/" || path === "" || path.includes("index") || path.includes("workbench")) return 1;
  return null;
}

export function getIndexFromTabParam(tab: TabParam): number | null {
  const value = Array.isArray(tab) ? tab[0] : tab;
  if (value === "settings") return 3;
  if (value === "monitor") return 2;
  if (value === "sessions" || value === "host-sessions") return 0;
  if (value === "workbench" || value === "dashboard") return 1;
  return null;
}

export function firstTabParam(tab: TabParam): string | null {
  const value = Array.isArray(tab) ? tab[0] : tab;
  return typeof value === "string" ? value : null;
}

export function getFocusedRoute(state: NavigationStateLike | undefined): NavigationRouteLike | null {
  let currentState = state;
  let route: NavigationRouteLike | null = null;
  while (currentState?.routes?.length) {
    const index = typeof currentState.index === "number"
      ? Math.max(0, Math.min(currentState.index, currentState.routes.length - 1))
      : currentState.routes.length - 1;
    route = currentState.routes[index] ?? null;
    currentState = route?.state;
  }
  return route;
}

function getRootFocusedRoute(state: NavigationStateLike | undefined): NavigationRouteLike | null {
  if (!state?.routes?.length) return null;
  const index = typeof state.index === "number"
    ? Math.max(0, Math.min(state.index, state.routes.length - 1))
    : state.routes.length - 1;
  return state.routes[index] ?? null;
}

export function getTabsNavigationIdentity(
  state: NavigationStateLike | undefined,
  pathname: string,
  tab: TabParam,
): TabsNavigationIdentity | null {
  let rootRoute = getRootFocusedRoute(state);
  if (!rootRoute) return null;
  if (rootRoute.name === "__root" && rootRoute.state) {
    rootRoute = getRootFocusedRoute(rootRoute.state);
  }
  if (!rootRoute) return null;
  const focusedRoute = getFocusedRoute(state);
  const rootName = rootRoute.name ?? "";
  return {
    isTabsRootFocused: rootName === "(tabs)" || rootName === "tabs",
    rootKey: rootRoute.key ?? null,
    focusedKey: focusedRoute?.key ?? rootRoute.key ?? null,
    pathname,
    tab: firstTabParam(tab),
  };
}

/**
 * A child screen can leave and re-enter the same tabs route while global URL
 * values still describe the child. Only a new tabs route key or a change made
 * while tabs is focused is a local Pager navigation intent.
 */
export function shouldApplyTabsRouteIntent(
  previous: TabsEntrySnapshot | null,
  next: TabsNavigationIdentity,
  lastTabsRootKey: string | null,
  wasTabsFocused: boolean,
  lastTabsEntry: TabsEntrySnapshot | null = null,
): boolean {
  if (!next.isTabsRootFocused) return false;
  if (!previous) return true;
  if (!wasTabsFocused && next.rootKey === lastTabsRootKey) {
    if (lastTabsEntry?.focusedKey === next.focusedKey) return false;
    return true;
  }
  if (next.rootKey !== lastTabsRootKey) return true;
  return next.pathname !== previous.pathname || next.tab !== previous.tab;
}

export function selectDashboardTab(
  onSelectTab: ((index: number) => void) | undefined,
  index: number,
  route: string,
  push: (route: string) => void,
): void {
  if (onSelectTab) {
    onSelectTab(index);
    return;
  }
  push(route);
}

export function clampTabIndex(index: number): number {
  return Math.max(0, Math.min(TAB_COUNT - 1, Math.round(index)));
}

export function getPageIndex(offset: number, pageWidth: number): number | null {
  if (pageWidth <= 0 || !Number.isFinite(offset)) return null;
  return clampTabIndex(offset / pageWidth);
}

export interface PagerEndDecision {
  index: number | null;
  pending: number | null;
}

/** Ignore an old native end callback when the actual offset is not at latest target. */
export function decidePagerEnd(
  offset: number,
  pageWidth: number,
  pendingTarget: number | null,
  userDragged: boolean,
): PagerEndDecision {
  const index = getPageIndex(offset, pageWidth);
  if (index === null) return { index: null, pending: pendingTarget };
  if (!userDragged && pendingTarget !== null && index !== pendingTarget) {
    return { index: null, pending: pendingTarget };
  }
  return { index, pending: null };
}
