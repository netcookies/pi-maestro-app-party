import { Tabs, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native";
import { HostStoreProvider } from "../src/store";
import { ThemeProvider, useTheme } from "../src/theme";
import { LineIcon, type LineIconName } from "../src/components/LineIcon";
import { loadConfig } from "../src/config";
import { useEffect } from "react";

/**
 * 导航架构（方向 A：Dashboard 工作台为首页）：
 * 主壳 = 底部 Tabs 4 个（工作台 dashboard / 会话 host-sessions / Monitor / 设置），
 * 会话聊天 session 为 stack 内二级页（无 tab）。
 * index 不再 Redirect，直接作为工作台态势总览页；Teammate 页保留为会话页二级入口（待后续接入）。
 */
const TAB_ICONS: Record<string, LineIconName> = {
  dashboard: "brain",
  "host-sessions": "image",
  teammate: "plan",
  monitor: "bolt",
  settings: "compress",
};

const TAB_LABELS: Record<string, string> = {
  dashboard: "工作台",
  sessions: "会话",
  monitor: "Monitor",
  settings: "设置",
};

function RootNavigator() {
  const { theme } = useTheme();
  return (
    <>
      <StatusBar style={theme.bg === "#f7f7f5" || theme.name === "notion" ? "dark" : "light"} />
      <Tabs
        screenOptions={{
          initialRouteName: "index",
          headerStyle: { backgroundColor: theme.headerBg },
          headerTintColor: theme.headerText,
          headerTitleStyle: { fontSize: 24, fontWeight: "700" },
          contentStyle: { backgroundColor: theme.bg },
          tabBarActiveTintColor: theme.accent,
          tabBarInactiveTintColor: theme.muted,
          tabBarStyle: {
            backgroundColor: theme.headerBg,
            borderTopColor: theme.border,
          },
          tabBarIcon: (opts) => {
            // P3-6：按 route name 取真实图标（此前写死 sessions 图标）；
            // 各 Screen 已自行覆盖时此处不会触发，仅作为兜底。
            // 防御：深链（maestro-mobile://pair）会让非 tab 路由进入这里且部分导航版本 route 可能为空
            const name = TAB_ICONS[opts?.route?.name ?? ""] ?? "plan";
            return <LineIcon name={name} size={22} color={opts?.color ?? "#888"} />;
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "工作台",
            tabBarIcon: ({ color }) => <LineIcon name="brain" size={22} color={color} />,
          }}
        />
        <Tabs.Screen
          name="host-sessions"
          options={{
            title: "会话",
            tabBarIcon: ({ color }) => <LineIcon name="image" size={22} color={color} />,
          }}
        />
        <Tabs.Screen
          name="teammate"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="pair"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="pair-scan"
          options={{ href: null, headerShown: false }}
        />
        <Tabs.Screen
          name="monitor"
          options={{
            title: "Monitor",
            tabBarIcon: ({ color }) => <LineIcon name="bolt" size={22} color={color} />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "设置",
            tabBarIcon: ({ color }) => <LineIcon name="compress" size={22} color={color} />,
          }}
        />
        <Tabs.Screen
          name="session"
          options={{ href: null, headerShown: false }}
        />
      </Tabs>
    </>
  );
}

export default function RootLayout() {
  // 启动即加载持久化配置（设置页参数 / 主题共享加载时机）
  useEffect(() => {
    void loadConfig();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <HostStoreProvider>
            <RootNavigator />
          </HostStoreProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
