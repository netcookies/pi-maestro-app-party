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
import { usePathname, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/theme";
import { useI18n } from "../../src/i18n";
import { LineIcon, type LineIconName } from "../../src/components/LineIcon";
import { hapticImpactLight } from "../../src/utils/haptics";
import DashboardScreen from "./index";
import HostSessionsScreen from "./host-sessions";
import MonitorScreen from "./monitor";
import SettingsScreen from "./settings";

interface TabDef {
  key: string;
  icon: LineIconName;
  labelKey: "tabWorkbench" | "tabSessions" | "tabMonitor" | "tabSettings";
}

const TABS: TabDef[] = [
  { key: "sessions", icon: "chat", labelKey: "tabSessions" },
  { key: "workbench", icon: "workbench", labelKey: "tabWorkbench" },
  { key: "monitor", icon: "monitor", labelKey: "tabMonitor" },
  { key: "settings", icon: "settings", labelKey: "tabSettings" },
];

export const unstable_settings = { initialRouteName: "index" };

let lastActiveTabIndex = 1;

function getIndexFromPathname(path: string): number | null {
  if (path.includes("settings")) return 3;
  if (path.includes("monitor")) return 2;
  if (path.includes("host-sessions") || path.includes("sessions")) return 0;
  if (path === "/" || path === "" || path.includes("index") || path.includes("workbench")) return 1;
  return null; // 非 tabs 路由返回 null，绝不误篡改当前激活的 Tab
}

export default function TabLayout() {
  const { theme } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ tab?: string }>();

  const [pageWidth, setPageWidth] = useState(() => Dimensions.get("window").width);
  const [activeIndex, setActiveIndex] = useState(() => {
    if (params.tab) {
      if (params.tab === "settings") return 3;
      if (params.tab === "monitor") return 2;
      if (params.tab === "sessions" || params.tab === "host-sessions") return 0;
      if (params.tab === "workbench" || params.tab === "dashboard") return 1;
    }
    if (!params.tab && pathname.includes("host-sessions")) return 0;
    const fromPath = getIndexFromPathname(pathname);
    return fromPath !== null ? fromPath : lastActiveTabIndex;
  });
  const pagerRef = useRef<ScrollView>(null);
  const isProgrammaticScroll = useRef(false);
  const initialPathHandled = useRef(false);

  // 监听 query 参数中的 tab
  useEffect(() => {
    if (params.tab) {
      let target: number | null = null;
      if (params.tab === "settings") target = 3;
      else if (params.tab === "monitor") target = 2;
      else if (params.tab === "sessions" || params.tab === "host-sessions") target = 0;
      else if (params.tab === "workbench" || params.tab === "dashboard") target = 1;

      if (target !== null && target !== activeIndex) {
        lastActiveTabIndex = target;
        setActiveIndex(target);
        if (pageWidth > 0) {
          isProgrammaticScroll.current = true;
          pagerRef.current?.scrollTo({ x: target * pageWidth, animated: true });
          setTimeout(() => {
            isProgrammaticScroll.current = false;
          }, 350);
        }
      }
    }
  }, [params.tab, pageWidth]);

  // 初始挂载或屏幕宽度就绪时，恢复至记忆的 Tab 位置
  useEffect(() => {
    if (activeIndex > 0 && pageWidth > 0) {
      pagerRef.current?.scrollTo({ x: activeIndex * pageWidth, animated: false });
    }
  }, [pageWidth]);

  // 监听外部路由变化（仅当属于具体某个 tab 路由时响应）
  useEffect(() => {
    if (params.tab) return;
    if (!initialPathHandled.current && pathname.includes("host-sessions")) {
      initialPathHandled.current = true;
      return;
    }
    initialPathHandled.current = true;
    const target = getIndexFromPathname(pathname);
    if (target !== null && target !== activeIndex) {
      lastActiveTabIndex = target;
      setActiveIndex(target);
      if (pageWidth > 0) {
        isProgrammaticScroll.current = true;
        pagerRef.current?.scrollTo({ x: target * pageWidth, animated: true });
        setTimeout(() => {
          isProgrammaticScroll.current = false;
        }, 350);
      }
    }
  }, [pathname]);

  const handleTabPress = useCallback(
    (index: number) => {
      if (index === activeIndex) return;
      void hapticImpactLight();
      lastActiveTabIndex = index;
      setActiveIndex(index);
      if (pageWidth > 0) {
        isProgrammaticScroll.current = true;
        pagerRef.current?.scrollTo({ x: index * pageWidth, animated: true });
        setTimeout(() => {
          isProgrammaticScroll.current = false;
        }, 350);
      }
    },
    [activeIndex, pageWidth],
  );

  const handleMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (isProgrammaticScroll.current || pageWidth <= 0) return;
      const x = e.nativeEvent.contentOffset.x;
      const nextIndex = Math.max(0, Math.min(TABS.length - 1, Math.round(x / pageWidth)));
      if (nextIndex !== activeIndex) {
        void hapticImpactLight();
        lastActiveTabIndex = nextIndex;
        setActiveIndex(nextIndex);
      }
    },
    [activeIndex, pageWidth],
  );

  return (
    <View
      style={[styles.container, { backgroundColor: theme.bg }]}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && Math.abs(w - pageWidth) > 1) {
          setPageWidth(w);
          setTimeout(() => {
            pagerRef.current?.scrollTo({ x: activeIndex * w, animated: false });
          }, 0);
        }
      }}
    >
      {/* 方案 B：纯原生连续跟手左右滑动 Pager 容器 */}
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        scrollEventThrottle={16}
        directionalLockEnabled
        keyboardShouldPersistTaps="handled"
        onMomentumScrollEnd={handleMomentumScrollEnd}
        style={styles.pager}
        contentContainerStyle={{ width: pageWidth * 4 }}
      >
        <View style={{ width: pageWidth, height: "100%" }}>
          <HostSessionsScreen />
        </View>
        <View style={{ width: pageWidth, height: "100%" }}>
          <DashboardScreen />
        </View>
        <View style={{ width: pageWidth, height: "100%" }}>
          <MonitorScreen active={activeIndex === 2} />
        </View>
        <View style={{ width: pageWidth, height: "100%" }}>
          <SettingsScreen />
        </View>
      </ScrollView>

      {/* 标准 MIUIX 贴底 Dock 导航栏：带图标微动、双语文字与安全区自动适配 */}
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

