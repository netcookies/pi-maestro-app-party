import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import { useGlobalSearchParams, usePathname, useRootNavigationState } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/theme";
import { useI18n } from "../../src/i18n";
import { LineIcon, type LineIconName } from "../../src/components/LineIcon";
import { hapticImpactLight } from "../../src/utils/haptics";
import DashboardScreen from "./index";
import HostSessionsScreen from "./host-sessions";
import MonitorScreen from "./monitor";
import SettingsScreen from "./settings";
import {
  clampTabIndex,
  decidePagerEnd,
  getIndexFromPathname,
  getIndexFromTabParam,
  getTabsNavigationIdentity,
  shouldApplyTabsRouteIntent,
  type TabsEntrySnapshot,
} from "../../src/tab-pager";

const TABS = [
  { key: "sessions", icon: "chat" as LineIconName, labelKey: "tabSessions" as const },
  { key: "workbench", icon: "workbench" as LineIconName, labelKey: "tabWorkbench" as const },
  { key: "monitor", icon: "monitor" as LineIconName, labelKey: "tabMonitor" as const },
  { key: "settings", icon: "settings" as LineIconName, labelKey: "tabSettings" as const },
];

export const unstable_settings = { initialRouteName: "index" };

let lastActiveTabIndex = 1;

export default function TabLayout() {
  const { theme } = useTheme();
  const { t } = useI18n();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ tab?: string | string[] }>();
  const navigationState = useRootNavigationState();
  const insets = useSafeAreaInsets();

  const [pageWidth, setPageWidth] = useState(() => Dimensions.get("window").width);
  const [activeIndex, setActiveIndex] = useState(() => {
    const fromParam = getIndexFromTabParam(params.tab);
    if (fromParam !== null) return fromParam;
    const fromPath = getIndexFromPathname(pathname);
    return fromPath !== null ? fromPath : lastActiveTabIndex;
  });
  const pagerRef = useRef<ScrollView>(null);
  const pageWidthRef = useRef(pageWidth);
  const activeIndexRef = useRef(activeIndex);
  const pendingTargetRef = useRef<number | null>(null);
  const userDraggingRef = useRef(false);
  const actualOffsetRef = useRef(0);
  const entryRef = useRef<TabsEntrySnapshot | null>(null);
  const lastTabsEntryRef = useRef<TabsEntrySnapshot | null>(null);
  const lastTabsRootKeyRef = useRef<string | null>(null);

  activeIndexRef.current = activeIndex;
  pageWidthRef.current = pageWidth;

  const scrollToIndex = useCallback((index: number, animated: boolean) => {
    const nextIndex = clampTabIndex(index);
    const width = pageWidthRef.current;
    if (width <= 0) return;
    pendingTargetRef.current = nextIndex;
    pagerRef.current?.scrollTo({ x: nextIndex * width, animated });
  }, []);

  // Only a focused Tabs route entry can be an external tab intent. A child
  // route returning to the existing Tabs entry is deliberately ignored.
  useEffect(() => {
    const identity = getTabsNavigationIdentity(navigationState, pathname, params.tab);
    if (!identity) return;
    const previous = entryRef.current;
    const wasTabsFocused = previous?.isTabsRootFocused ?? false;
    const shouldApply = shouldApplyTabsRouteIntent(
      previous,
      identity,
      lastTabsRootKeyRef.current,
      wasTabsFocused,
      lastTabsEntryRef.current,
    );
    entryRef.current = identity;
    if (identity.isTabsRootFocused) {
      lastTabsRootKeyRef.current = identity.rootKey;
      lastTabsEntryRef.current = identity;
    }
    if (!shouldApply) return;

    const target = getIndexFromTabParam(params.tab) ?? getIndexFromPathname(pathname);
    if (target === null) return;
    lastActiveTabIndex = target;
    setActiveIndex(target);
    activeIndexRef.current = target;
    scrollToIndex(target, previous !== null);
  }, [navigationState, params.tab, pathname, scrollToIndex]);

  // Rotation and split-view changes only reposition the current page.
  useEffect(() => {
    if (pageWidth <= 0) return;
    scrollToIndex(activeIndexRef.current, false);
  }, [pageWidth, scrollToIndex]);

  const handleTabPress = useCallback((index: number) => {
    const nextIndex = clampTabIndex(index);
    const sameTab = nextIndex === activeIndexRef.current;
    if (!sameTab) void hapticImpactLight();
    lastActiveTabIndex = nextIndex;
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);
    scrollToIndex(nextIndex, !sameTab);
  }, [scrollToIndex]);

  const handleMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const width = pageWidthRef.current;
      const eventOffset = e.nativeEvent.contentOffset.x;
      const actualOffset = Math.abs(actualOffsetRef.current - eventOffset) > 1
        ? actualOffsetRef.current
        : eventOffset;
      const decision = decidePagerEnd(
        actualOffset,
        width,
        pendingTargetRef.current,
        userDraggingRef.current,
      );
      if (decision.index === null) {
        if (decision.pending !== null) pagerRef.current?.scrollTo({ x: decision.pending * width, animated: false });
        return;
      }
      pendingTargetRef.current = decision.pending;
      userDraggingRef.current = false;
      const nextIndex = decision.index;
      if (nextIndex !== activeIndexRef.current) {
        void hapticImpactLight();
        lastActiveTabIndex = nextIndex;
        activeIndexRef.current = nextIndex;
        setActiveIndex(nextIndex);
      }
    },
    [],
  );

  return (
    <View
      style={[styles.container, { backgroundColor: theme.bg }]}
      onLayout={(e) => {
        const width = e.nativeEvent.layout.width;
        if (width > 0 && Math.abs(width - pageWidthRef.current) > 1) {
          pageWidthRef.current = width;
          setPageWidth(width);
        }
      }}
    >
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        scrollEventThrottle={16}
        directionalLockEnabled
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => {
          userDraggingRef.current = true;
          pendingTargetRef.current = null;
        }}
        onScroll={(e) => {
          actualOffsetRef.current = e.nativeEvent.contentOffset.x;
        }}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        style={styles.pager}
        contentContainerStyle={{ width: pageWidth * 4 }}
      >
        <View style={{ width: pageWidth, height: "100%" }}>
          <HostSessionsScreen active={activeIndex === 0} />
        </View>
        <View style={{ width: pageWidth, height: "100%" }}>
          <DashboardScreen active={activeIndex === 1} onSelectTab={handleTabPress} />
        </View>
        <View style={{ width: pageWidth, height: "100%" }}>
          <MonitorScreen active={activeIndex === 2} />
        </View>
        <View style={{ width: pageWidth, height: "100%" }}>
          <SettingsScreen />
        </View>
      </ScrollView>

      <View
        style={[
          styles.dockContainer,
          {
            backgroundColor: theme.headerBg,
            borderTopColor: theme.border,
            paddingBottom: Math.max(insets.bottom, 12),
          },
        ]}
      >
        {TABS.map((tab, idx) => {
          const isActive = activeIndex === idx;
          const color = isActive ? theme.accent : theme.muted;
          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.dockItem}
              onPress={() => handleTabPress(idx)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t[tab.labelKey]}
              accessibilityState={{ selected: isActive }}
            >
              <LineIcon name={tab.icon} size={20} color={color} />
              <Text
                style={[
                  styles.dockLabel,
                  { color, fontWeight: isActive ? "700" : "500" },
                ]}
              >
                {t[tab.labelKey]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  pager: {
    flex: 1,
  },
  dockContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    borderTopWidth: 1,
    paddingTop: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 8,
  },
  dockItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingVertical: 2,
  },
  dockLabel: {
    fontSize: 11,
  },
});

