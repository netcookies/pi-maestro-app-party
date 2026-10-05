import { describe, expect, it } from "vitest";
import {
  decidePagerEnd,
  getIndexFromPathname,
  getIndexFromTabParam,
  getPageIndex,
  getTabsNavigationIdentity,
  selectDashboardTab,
  shouldApplyTabsRouteIntent,
  type TabsEntrySnapshot,
} from "../src/tab-pager";

function tabsState(rootKey = "tabs-root", focusedKey = "tab-settings") {
  return {
    index: 0,
    routes: [{
      key: rootKey,
      name: "(tabs)",
      state: {
        index: 0,
        routes: [{ key: focusedKey, name: "settings" }],
      },
    }],
  };
}

function childState(rootKey = "session-root", childKey = "session-leaf") {
  return {
    index: 0,
    routes: [{
      key: rootKey,
      name: "session",
      state: { index: 0, routes: [{ key: childKey, name: "session" }] },
    }],
  };
}

describe("mobile tab Pager route mapping", () => {
  it("dispatches hosted Dashboard shortcuts to the Pager without fallback navigation", () => {
    const selected: number[] = [];
    const pushed: string[] = [];
    selectDashboardTab((index) => selected.push(index), 2, "/monitor", (route) => pushed.push(route));
    expect(selected).toEqual([2]);
    expect(pushed).toEqual([]);
  });

  it("keeps standalone Dashboard shortcuts on the router fallback", () => {
    const pushed: string[] = [];
    selectDashboardTab(undefined, 0, "/host-sessions", (route) => pushed.push(route));
    expect(pushed).toEqual(["/host-sessions"]);
  });

  it.each([
    ["settings", 3],
    ["monitor", 2],
    ["sessions", 0],
    ["host-sessions", 0],
    ["workbench", 1],
    ["dashboard", 1],
  ])("maps ?tab=%s to index %i", (tab, expected) => {
    expect(getIndexFromTabParam(tab)).toBe(expected);
  });

  it("supports array query values and ignores unknown aliases", () => {
    expect(getIndexFromTabParam(["monitor", "settings"])).toBe(2);
    expect(getIndexFromTabParam("unknown")).toBeNull();
    expect(getIndexFromTabParam(undefined)).toBeNull();
  });

  it.each([
    ["/settings", 3],
    ["/monitor", 2],
    ["/host-sessions", 0],
    ["/", 1],
  ])("maps explicit Tab pathname %s to index %i", (pathname, expected) => {
    expect(getIndexFromPathname(pathname)).toBe(expected);
  });

  it("uses focused route keys to ignore a child push/pop returning to the same Tabs entry", () => {
    const tabs = getTabsNavigationIdentity(tabsState(), "/settings", undefined)!;
    const child = getTabsNavigationIdentity(childState(), "/session", undefined)!;
    const returned = getTabsNavigationIdentity(tabsState(), "/settings", undefined)!;

    expect(shouldApplyTabsRouteIntent(null, tabs, null, false)).toBe(true);
    expect(shouldApplyTabsRouteIntent(tabs, child, tabs.rootKey, true)).toBe(false);
    expect(shouldApplyTabsRouteIntent(child, returned, tabs.rootKey, false, tabs)).toBe(false);
  });

  it("unwraps the installed Expo __root navigator for tab and child entries", () => {
    const wrap = (state: ReturnType<typeof tabsState>) => ({
      index: 0,
      routes: [{ key: "expo-root", name: "__root", state }],
    });
    const tabs = getTabsNavigationIdentity(wrap(tabsState()), "/settings", "monitor")!;
    const child = getTabsNavigationIdentity(wrap(childState()), "/session", undefined)!;
    const returned = getTabsNavigationIdentity(wrap(tabsState()), "/settings", "monitor")!;
    expect(tabs).toMatchObject({ isTabsRootFocused: true, rootKey: "tabs-root", focusedKey: "tab-settings" });
    expect(child.isTabsRootFocused).toBe(false);
    expect(shouldApplyTabsRouteIntent(null, tabs, null, false)).toBe(true);
    expect(shouldApplyTabsRouteIntent(child, returned, tabs.rootKey, false, tabs)).toBe(false);
    const hot = getTabsNavigationIdentity(wrap(tabsState()), "/settings", "sessions")!;
    expect(shouldApplyTabsRouteIntent(tabs, hot, tabs.rootKey, true, tabs)).toBe(true);
  });

  it("accepts a newly requested root route and hot query alias", () => {
    const previous = getTabsNavigationIdentity(tabsState("tabs-root", "settings"), "/settings", undefined)!;
    const nextPath = getTabsNavigationIdentity(tabsState("tabs-root", "monitor"), "/monitor", undefined)!;
    const nextQuery = getTabsNavigationIdentity(tabsState("tabs-root", "monitor"), "/settings", "monitor")!;

    const requestedMonitor = getTabsNavigationIdentity(tabsState("tabs-root", "monitor"), "/monitor", undefined)!;

    expect(shouldApplyTabsRouteIntent(previous, nextPath, previous.rootKey, true)).toBe(true);
    expect(shouldApplyTabsRouteIntent(previous, nextQuery, previous.rootKey, true)).toBe(true);
    expect(shouldApplyTabsRouteIntent(previous, requestedMonitor, previous.rootKey, false, previous)).toBe(true);
    expect(getIndexFromTabParam(nextQuery.tab ?? undefined)).toBe(2);
  });

  it("recognizes a new Tabs root even when its pathname is stale", () => {
    const previous: TabsEntrySnapshot = {
      isTabsRootFocused: false,
      rootKey: "session-root",
      focusedKey: "session-leaf",
      pathname: "/session",
      tab: null,
    };
    const next = getTabsNavigationIdentity(tabsState("new-tabs-root", "index"), "/settings", undefined)!;

    expect(shouldApplyTabsRouteIntent(previous, next, "old-tabs-root", false)).toBe(true);
  });
});

describe("mobile tab Pager scroll decisions", () => {
  it("repositions the current page for width changes without changing its index", () => {
    expect(getPageIndex(3 * 390, 390)).toBe(3);
    expect(getPageIndex(3 * 844, 844)).toBe(3);
  });

  it("does not let an old native end callback overwrite a pending tap", () => {
    expect(decidePagerEnd(390, 390, 3, false)).toEqual({ index: null, pending: 3 });
    expect(decidePagerEnd(3 * 390, 390, 3, false)).toEqual({ index: 3, pending: null });
  });

  it("lets an explicit user drag cancel the pending programmatic target", () => {
    expect(decidePagerEnd(2 * 390, 390, 3, true)).toEqual({ index: 2, pending: null });
  });
});
